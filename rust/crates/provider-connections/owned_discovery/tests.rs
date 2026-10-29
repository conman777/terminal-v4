//! UNAPPLIED child-of-owned_discovery preview; private proposed ports not implemented.
use super::*;
use crate::{fixtures::*, leases::*, *};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

const CREATE: &str = "60000000-0000-4000-8000-000000000009";
struct ExitRelease(Option<mpsc::Sender<()>>);
impl ExitRelease {
    fn release(&mut self) {
        if let Some(exit) = self.0.take() {
            let _ = exit.send(());
        }
    }
}
impl Drop for ExitRelease {
    fn drop(&mut self) {
        self.release();
    }
}
struct ThreadStart {
    failed_owned: bool,
    starts: Arc<AtomicUsize>,
    joins: Arc<AtomicUsize>,
    ready: mpsc::Sender<()>,
    stop_seen: mpsc::Sender<()>,
    exit: mpsc::Receiver<()>,
}
struct ThreadOwner {
    thread: Option<std::thread::JoinHandle<()>>,
    stop: Option<mpsc::Sender<()>>,
    joins: Arc<AtomicUsize>,
}
impl StartOwnedResource for ThreadStart {
    fn start(self: Box<Self>) -> StartOutcome {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (stop, stopped) = mpsc::channel();
        let ready = self.ready;
        let seen = self.stop_seen;
        let exit = self.exit;
        let thread = std::thread::spawn(move || {
            let _ = ready.send(());
            let _ = stopped.recv();
            let _ = seen.send(());
            let _ = exit.recv();
        });
        let owner = Box::new(ThreadOwner {
            thread: Some(thread),
            stop: Some(stop),
            joins: self.joins,
        });
        // Bounded synchronous ownership transfer, no blocked handshake here.
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
impl OwnedRunningResource for ThreadOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| LeaseError::ResourceStopPending)?;
            self.joins.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}
impl Drop for ThreadOwner {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // Drop does not increment joins or manufacture accepted stop evidence.
    }
}
fn prepared() -> (tempfile::TempDir, OwnedDiscovery, EffectiveConnection) {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let mut coordinator = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.operation_id = CREATE.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    coordinator
        .configure(ConfigMutation::Put(request), save)
        .unwrap();
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    let snapshot = runtime::resolve(&scope(), &profile, &reference_for(&profile), None).unwrap();
    let owned = OwnedDiscovery::from_owned_parts(scope(), JobStore::new(), coordinator);
    (root, owned, snapshot)
}
type Worker = (
    Box<dyn StartOwnedResource>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    mpsc::Receiver<()>,
    mpsc::Receiver<()>,
    ExitRelease,
);
fn worker(failed_owned: bool) -> Worker {
    let starts = Arc::new(AtomicUsize::new(0));
    let joins = Arc::new(AtomicUsize::new(0));
    let (ready, ready_rx) = mpsc::channel();
    let (seen, seen_rx) = mpsc::channel();
    let (exit, exit_rx) = mpsc::channel();
    (
        Box::new(ThreadStart {
            failed_owned,
            starts: starts.clone(),
            joins: joins.clone(),
            ready,
            stop_seen: seen,
            exit: exit_rx,
        }),
        starts,
        joins,
        ready_rx,
        seen_rx,
        ExitRelease(Some(exit)),
    )
}

#[test]
fn failed_publication_remains_readable_and_pending_until_original_blocked_worker_is_joined() {
    let (_root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, stopped, release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let reader = owned.reader();
    let before = reader.job(REQUEST).unwrap();
    assert_eq!(before["status"], "failed");
    assert_eq!(before["cleanupPending"], true);
    let (owned, after) = std::thread::scope(|scope| {
        // Local RAII release runs during unwinding before scope auto-joins worker.
        let mut release = release;
        let attempt = scope.spawn(move || {
            let result = owned.drain_failed(REQUEST, 3).unwrap();
            (owned, result)
        });
        let stop_observed = stopped.recv_timeout(Duration::from_secs(3));
        let (probe_tx, probe_rx) = mpsc::channel();
        let probe = scope.spawn(move || {
            let _ = probe_tx.send(reader.job(REQUEST));
        });
        let timely_reader = probe_rx.recv_timeout(Duration::from_secs(3));
        let joins_before_release = joins.load(Ordering::SeqCst);
        // Release before ANY assertions/joins: holding JobStore across join must
        // cause a bounded failed assertion, not a deadlock in this test harness.
        release.release();
        let probe_finished = probe.join();
        let attempt_finished = attempt.join();
        assert!(
            stop_observed.is_ok(),
            "original cancellation reached worker"
        );
        assert!(probe_finished.is_ok());
        assert!(timely_reader.is_ok(), "reader blocked behind actual join");
        assert_eq!(
            timely_reader.unwrap().unwrap(),
            before,
            "no job lock held across join"
        );
        assert_eq!(joins_before_release, 0);
        attempt_finished.unwrap()
    });
    assert_eq!(after["status"], "failed");
    assert_eq!(after["completedMs"], before["completedMs"]);
    assert_eq!(after["error"], before["error"]);
    assert_eq!(after["cleanupPending"], false);
    assert!(after["models"].is_null() && after["receipt"].is_null());
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    drop(owned);
}

#[test]
fn durable_gate_c_fact_before_job_cas_retries_original_completed_handle_and_proof_without_rejoining(
) {
    let (root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, _stopped, mut release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    release.release();
    owned.fail_once(FailurePoint::AfterGateCReleaseBeforeJobCas);
    assert_eq!(
        owned.drain_failed(REQUEST, 3).err(),
        Some(DrainError::Job(Error::PersistenceFailed))
    );
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    let (status, fact): (String, Option<String>) = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "quiescent");
    assert!(
        fact.is_some(),
        "actual release committed before injected interruption"
    );
    // New observe_stop would correctly fail for a completed handle. Retry must
    // use the retained original proof and borrowed idempotent release instead.
    let settled = owned.drain_failed(REQUEST, 4).unwrap();
    assert_eq!(settled["cleanupPending"], false);
    assert_eq!(settled["status"], before["status"]);
    assert_eq!(settled["error"], before["error"]);
    assert_eq!(settled["completedMs"], before["completedMs"]);
    assert_eq!(owned.drain_failed(REQUEST, 5).unwrap(), settled);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
}

#[test]
fn original_failed_owned_and_postcallback_sql_failure_resources_survive_until_actual_bridge_join() {
    for failed_owned in [true, false] {
        let (root, mut owned, snapshot) = prepared();
        let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
        if !failed_owned {
            db.execute_batch("CREATE TRIGGER drain_test_abort_started BEFORE UPDATE OF started ON provider_connection_actors WHEN NEW.started=1 BEGIN SELECT RAISE(ABORT,'synthetic status failure'); END;").unwrap();
        }
        let (action, starts, joins, ready, stopped, release) = worker(failed_owned);
        let failure = owned
            .begin_owned(REQUEST, &snapshot, action, 1)
            .err()
            .unwrap();
        assert_eq!(
            failure,
            DrainError::Lease(if failed_owned {
                LeaseError::HandoffFailed
            } else {
                LeaseError::PersistenceFailed
            })
        );
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        if !failed_owned {
            db.execute_batch("DROP TRIGGER drain_test_abort_started")
                .unwrap();
        }
        let reader = owned.reader();
        let before = reader.job(REQUEST).unwrap();
        assert_eq!(before["status"], "failed");
        assert_eq!(before["cleanupPending"], true);
        let after = std::thread::scope(|scope| {
            let mut release = release;
            let attempt = scope.spawn(move || owned.drain_failed(REQUEST, 3).unwrap());
            let stop_observed = stopped.recv_timeout(Duration::from_secs(3));
            let (probe_tx, probe_rx) = mpsc::channel();
            let probe = scope.spawn(move || {
                let _ = probe_tx.send(reader.job(REQUEST));
            });
            let timely_reader = probe_rx.recv_timeout(Duration::from_secs(3));
            let joins_before_release = joins.load(Ordering::SeqCst);
            release.release();
            let probe_finished = probe.join();
            let attempt_finished = attempt.join();
            assert!(
                stop_observed.is_ok(),
                "original cancellation reached worker"
            );
            assert!(probe_finished.is_ok());
            assert!(timely_reader.is_ok(), "reader blocked behind actual join");
            assert_eq!(timely_reader.unwrap().unwrap(), before);
            assert_eq!(joins_before_release, 0);
            attempt_finished.unwrap()
        });
        assert_eq!(after["cleanupPending"], false);
        assert_eq!(after["status"], before["status"]);
        assert_eq!(after["error"], before["error"]);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(joins.load(Ordering::SeqCst), 1);
    }
}

fn actor_row(db: &rusqlite::Connection) -> Vec<rusqlite::types::Value> {
    db.query_row("SELECT * FROM provider_connection_actors", [], |row| {
        (0..row.as_ref().column_count())
            .map(|column| row.get(column))
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
}

#[test]
fn failed_gate_c_stop_fact_sql_write_retains_original_observed_proof_for_retry() {
    let (root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, _stopped, mut release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    let original_view = owned
        .coordinator
        .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
        .unwrap();
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    let actor_before = actor_row(&db);
    db.execute_batch("CREATE TRIGGER drain_test_abort_stop_fact BEFORE UPDATE OF stop_evidence_json ON provider_connection_actors WHEN NEW.stop_evidence_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic stop-fact failure'); END;").unwrap();
    assert_eq!(owned.test_observe_calls(), 0);
    release.release();
    assert_eq!(
        owned.drain_failed(REQUEST, 3).err(),
        Some(DrainError::Lease(LeaseError::PersistenceFailed))
    );
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    assert_eq!(
        actor_row(&db),
        actor_before,
        "complete actor row rolled back"
    );
    let (status, fact): (String, Option<String>) = db
        .query_row(
            "SELECT status,stop_evidence_json FROM provider_connection_actors",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "active");
    assert!(
        fact.is_none(),
        "failed release must not claim an accepted fact"
    );
    assert!(owned.entries[0].original_handle.is_some());
    assert!(owned.entries[0].original_proof.is_some());
    assert!(matches!(&owned.entries[0].phase, DrainPhase::Observed));
    assert_eq!(
        owned
            .coordinator
            .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
            .unwrap(),
        original_view
    );
    {
        let jobs = owned.jobs.lock().unwrap();
        let job = jobs
            .records
            .iter()
            .find(|job| job.key.request_id == REQUEST)
            .unwrap();
        assert_eq!(job.io, IoState::Active);
    }
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    assert_eq!(owned.test_observe_calls(), 1);
    db.execute_batch("DROP TRIGGER drain_test_abort_stop_fact")
        .unwrap();
    let settled = owned.drain_failed(REQUEST, 4).unwrap();
    assert_eq!(settled["cleanupPending"], false);
    assert_eq!(settled["status"], before["status"]);
    assert_eq!(settled["error"], before["error"]);
    assert_eq!(settled["completedMs"], before["completedMs"]);
    assert!(settled["models"].is_null() && settled["receipt"].is_null());
    assert_eq!(owned.drain_failed(REQUEST, 5).unwrap(), settled);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    assert_eq!(
        owned.test_observe_calls(),
        1,
        "retry uses retained original proof, not another observation"
    );
}

// Executable OD05-11 specifications. No implementation is present in this gate.
const SECOND_REQUEST: &str = "50000000-0000-4000-8000-000000000002";
const OTHER_PROFILE: &str = "10000000-0000-4000-8000-000000000002";
const OTHER_ACTOR: &str = "70000000-0000-4000-8000-000000000002";
const OTHER_BOOT: &str = "80000000-0000-4000-8000-000000000002";
const OTHER_LEASE: &str = "90000000-0000-4000-8000-000000000002";

fn prepared_kind(
    kind: ProfileKind,
    bearer: bool,
) -> (tempfile::TempDir, OwnedDiscovery, EffectiveConnection) {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let mut coordinator = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let auth = if bearer {
        AuthChange::ReplaceBearer(synthetic_secret())
    } else {
        AuthChange::None
    };
    let mut request = update(kind, auth);
    request.operation_id = CREATE.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    coordinator
        .configure(ConfigMutation::Put(request), save)
        .unwrap();
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    let snapshot = runtime::resolve(&scope(), &profile, &reference_for(&profile), None).unwrap();
    let owned = OwnedDiscovery::from_owned_parts(scope(), JobStore::new(), coordinator);
    assert_eq!(owned.scope, scope());
    (root, owned, snapshot)
}
fn fact_accepted(
    owned: &mut OwnedDiscovery,
    snapshot: &EffectiveConnection,
    request: &str,
) -> (Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let (action, starts, joins, ready, _stopped, mut release) = worker(false);
    owned.begin_owned(request, snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(request, Error::InvalidReceipt, 2)
        .unwrap();
    release.release();
    owned.fail_once(FailurePoint::AfterGateCReleaseBeforeJobCas);
    assert_eq!(
        owned.drain_failed(request, 3).err(),
        Some(DrainError::Job(Error::PersistenceFailed))
    );
    let index = owned
        .entries
        .iter()
        .position(|entry| entry.permit.key.request_id == request)
        .unwrap();
    assert!(matches!(
        &owned.entries[index].phase,
        DrainPhase::GateCFactAccepted
    ));
    assert!(owned.entries[index].original_proof.is_some());
    assert!(owned.entries[index].original_view.is_some());
    assert_eq!(owned.entries[index].snapshot, *snapshot);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    (starts, joins)
}
fn assert_fenced(error: DrainError) {
    assert!(
        matches!(
            error,
            DrainError::Job(Error::StaleResult)
                | DrainError::Lease(LeaseError::InvalidEvidence)
                | DrainError::Lease(LeaseError::StaleHandle)
        ),
        "unexpected error family: {error:?}"
    );
}
fn cohere_target(target: &mut TestDrainTarget) {
    let snapshot = &mut target.snapshot;
    let binding_target = CredentialTarget {
        scope: snapshot.reference.scope.clone(),
        profile_id: snapshot.reference.profile_id.clone(),
        kind: snapshot.kind,
        base_url: snapshot.base_url.clone(),
        transport: snapshot.transport,
    };
    match &mut snapshot.auth {
        StoredAuth::Bearer(binding) => {
            binding.target = binding_target;
            snapshot.reference.credential_id = Some(binding.id.clone());
            snapshot.reference.credential_generation = Some(binding.generation.clone());
        }
        StoredAuth::None => {
            snapshot.reference.credential_id = None;
            snapshot.reference.credential_generation = None;
        }
    }
    target.lease_view.reference = snapshot.reference.clone();
}
fn assert_target_structurally_valid(target: &TestDrainTarget) {
    super::super::validate_key(&target.key).unwrap();
    let profile = profile_from_snapshot(&target.snapshot);
    let resolved =
        runtime::resolve(&profile.scope, &profile, &target.snapshot.reference, None).unwrap();
    assert_eq!(
        resolved, target.snapshot,
        "negative target is independently valid data"
    );
}

#[test]
fn genuine_observed_original_proof_rejects_each_wrong_job_or_binding_then_accepts_original() {
    for field in [
        "store",
        "owner",
        "environment",
        "profile",
        "request",
        "worker-generation",
        "revision",
        "credential",
        "credential-generation",
        "endpoint",
        "cluster",
        "kind-derived-transport",
        "auth-mode",
        "actor",
        "boot",
        "lease",
    ] {
        let (_root, mut owned, snapshot) = match field {
            "kind-derived-transport" => prepared_kind(ProfileKind::ActualLocal, false),
            "auth-mode" | "endpoint" => prepared_kind(ProfileKind::LmStudioLocal, true),
            _ => prepared_kind(ProfileKind::ActualRelay, true),
        };
        let (starts, joins) = fact_accepted(&mut owned, &snapshot, REQUEST);
        let before = owned.reader().job(REQUEST).unwrap();
        let records_before = owned.jobs.lock().unwrap().records.clone();
        let original = owned.test_target_for_entry(0).unwrap();
        assert!(Arc::ptr_eq(
            &original.store_identity,
            &owned.jobs.lock().unwrap().identity
        ));
        assert_eq!(
            original.lease_view,
            owned
                .coordinator
                .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
                .unwrap()
        );
        let mut wrong = original.clone();
        match field {
            "store" => wrong.store_identity = Arc::new(()),
            "owner" => {
                wrong.key.scope.owner_id = "other-synthetic-owner".into();
                wrong.snapshot.reference.scope = wrong.key.scope.clone();
            }
            "environment" => {
                wrong.key.scope.environment_id = "other-synthetic-environment".into();
                wrong.snapshot.reference.scope = wrong.key.scope.clone();
            }
            "profile" => {
                wrong.key.profile_id = OTHER_PROFILE.into();
                wrong.snapshot.reference.profile_id = OTHER_PROFILE.into();
            }
            "request" => {
                wrong.key.request_id = SECOND_REQUEST.into();
                wrong.lease_view.request_id = SECOND_REQUEST.into();
            }
            "worker-generation" => wrong.worker_generation += 1,
            "revision" => wrong.snapshot.reference.revision = NEXT_REVISION.into(),
            "credential" => {
                if let StoredAuth::Bearer(binding) = &mut wrong.snapshot.auth {
                    binding.id = NEXT_CREDENTIAL.into();
                }
            }
            "credential-generation" => {
                if let StoredAuth::Bearer(binding) = &mut wrong.snapshot.auth {
                    binding.generation = NEXT_GENERATION.into();
                }
            }
            "endpoint" => wrong.snapshot.base_url = "http://127.0.0.1:1235/v1".into(),
            "cluster" => wrong.snapshot.cluster_id = Some("synthetic-cluster".into()),
            "kind-derived-transport" => {
                // Valid protocol concept: kind fixes transport in the domain.
                wrong.snapshot.kind = ProfileKind::LmStudioLocal;
                wrong.snapshot.transport = Transport::OpenAiChat;
            }
            "auth-mode" => wrong.snapshot.auth = StoredAuth::None,
            "actor" => wrong.lease_view.identity.actor_id = OTHER_ACTOR.into(),
            "boot" => wrong.lease_view.identity.process_instance_id = OTHER_BOOT.into(),
            _ => wrong.lease_view.identity.lease_id = OTHER_LEASE.into(),
        }
        cohere_target(&mut wrong);
        assert_target_structurally_valid(&wrong);
        assert_fenced(
            owned
                .test_settle_observed_target(0, &wrong, 4)
                .err()
                .unwrap(),
        );
        assert_eq!(
            owned.reader().job(REQUEST).unwrap(),
            before,
            "{field}: no false job ACK"
        );
        assert_eq!(
            owned.jobs.lock().unwrap().records,
            records_before,
            "{field}: complete authoritative records unchanged"
        );
        assert_eq!(owned.test_observe_calls(), 1);
        let settled = owned.test_settle_observed_target(0, &original, 5).unwrap();
        assert_eq!(
            settled["cleanupPending"], false,
            "{field}: original positive restore"
        );
        assert_eq!(settled["error"], before["error"]);
        assert_eq!(settled["completedMs"], before["completedMs"]);
        assert!(matches!(&owned.entries[0].phase, DrainPhase::Settled));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(joins.load(Ordering::SeqCst), 1);
    }
    // A lone wrong transport is structurally invalid for a fixed profile kind;
    // label it honestly, separately from the independently valid table above.
    let (_root, mut owned, snapshot) = prepared();
    fact_accepted(&mut owned, &snapshot, REQUEST);
    let original = owned.test_target_for_entry(0).unwrap();
    let mut invalid_transport = original.clone();
    invalid_transport.snapshot.transport = Transport::OpenAiChat;
    let invalid_profile = profile_from_snapshot(&invalid_transport.snapshot);
    assert!(validate_profile(&invalid_profile).is_err());
    let before = owned.reader().job(REQUEST).unwrap();
    let records_before = owned.jobs.lock().unwrap().records.clone();
    assert!(owned
        .test_settle_observed_target(0, &invalid_transport, 4)
        .is_err());
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    assert_eq!(owned.jobs.lock().unwrap().records, records_before);
    owned.test_settle_observed_target(0, &original, 5).unwrap();

    // The other coordinator has the same scope/root but no original live owner.
    let (root, mut owned, snapshot) = prepared();
    fact_accepted(&mut owned, &snapshot, REQUEST);
    let original = owned.test_target_for_entry(0).unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    let records_before = owned.jobs.lock().unwrap().records.clone();
    let other = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let original_coordinator = std::mem::replace(&mut owned.coordinator, other);
    assert_fenced(
        owned
            .test_settle_observed_target(0, &original, 4)
            .err()
            .unwrap(),
    );
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    assert_eq!(owned.jobs.lock().unwrap().records, records_before);
    let _other = std::mem::replace(&mut owned.coordinator, original_coordinator);
    owned.test_settle_observed_target(0, &original, 5).unwrap();

    // Same fullref is insufficient: two genuine observed leases cannot ACK each other.
    let (_root, mut owned, snapshot) = prepared();
    fact_accepted(&mut owned, &snapshot, REQUEST);
    fact_accepted(&mut owned, &snapshot, SECOND_REQUEST);
    let a = owned.test_target_for_entry(0).unwrap();
    let b = owned.test_target_for_entry(1).unwrap();
    let before_a = owned.reader().job(REQUEST).unwrap();
    let before_b = owned.reader().job(SECOND_REQUEST).unwrap();
    let records_before = owned.jobs.lock().unwrap().records.clone();
    assert_eq!(a.snapshot.reference, b.snapshot.reference);
    assert_fenced(owned.test_settle_observed_target(0, &b, 4).err().unwrap());
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before_a);
    assert_eq!(owned.reader().job(SECOND_REQUEST).unwrap(), before_b);
    assert_eq!(owned.jobs.lock().unwrap().records, records_before);
    owned.test_settle_observed_target(0, &a, 5).unwrap();
    owned.test_settle_observed_target(1, &b, 5).unwrap();
    assert_eq!(owned.test_observe_calls(), 2);
}

#[test]
fn dropping_reader_or_request_lifetime_does_not_drop_scope_supervisor_original_owner() {
    let (root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, stopped, release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let reader = owned.reader();
    assert_eq!(reader.scope, scope());
    assert!(Arc::ptr_eq(&reader.jobs, &owned.jobs));
    let request_result = reader.job(REQUEST).unwrap();
    drop(request_result);
    drop(reader); // A read/request result lifetime owns no resource capability.
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    assert!(owned.entries[0].original_handle.is_some());
    let before = owned.reader().job(REQUEST).unwrap();
    assert_eq!(before["cleanupPending"], true);
    assert_eq!(before["requestId"], REQUEST);
    assert_eq!(before["revision"], REVISION);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let settled = std::thread::scope(|scope| {
        let mut release = release;
        let attempt = scope.spawn(move || owned.drain_failed(REQUEST, 3).unwrap());
        let stopped_result = stopped.recv_timeout(Duration::from_secs(3));
        let joins_before = joins.load(Ordering::SeqCst);
        release.release();
        let result = attempt.join();
        assert!(stopped_result.is_ok());
        assert_eq!(joins_before, 0);
        result.unwrap()
    });
    assert_eq!(settled["cleanupPending"], false);
    assert_eq!(settled["error"], before["error"]);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
}

#[test]
fn scope_recovery_revokes_job_authority_but_keeps_original_resource_owned_for_supervised_stop() {
    let (root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, stopped, release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    let original = owned
        .coordinator
        .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
        .unwrap();
    // An independently valid other-owner queued entry shares this store solely
    // as a private fixture; selected-scope recovery must leave it byte-identical.
    let mut other_snapshot = snapshot.clone();
    other_snapshot.reference.scope.owner_id = "other-synthetic-owner".into();
    if let StoredAuth::Bearer(binding) = &mut other_snapshot.auth {
        binding.target.scope = other_snapshot.reference.scope.clone();
    }
    let other_scope = other_snapshot.reference.scope.clone();
    let other_before = super::super::begin(
        &mut owned.jobs.lock().unwrap(),
        &other_scope,
        &other_snapshot,
        SECOND_REQUEST,
        1,
    )
    .unwrap();
    owned.recover_scope(3).unwrap();
    assert_eq!(
        owned
            .jobs
            .lock()
            .unwrap()
            .records
            .iter()
            .find(|job| job.key == other_before.key)
            .unwrap(),
        &other_before
    );
    assert_eq!(
        owned.reader().job(SECOND_REQUEST).err(),
        Some(DrainError::Job(Error::NotFound))
    );
    let recovered = owned.reader().job(REQUEST).unwrap();
    assert_eq!(recovered["status"], before["status"]);
    assert_eq!(recovered["error"], before["error"]);
    assert_eq!(recovered["completedMs"], before["completedMs"]);
    assert_eq!(recovered["cleanupPending"], true);
    assert!(matches!(
        &owned.entries[0].phase,
        DrainPhase::AuthorityRevoked
    ));
    assert_eq!(
        owned
            .jobs
            .lock()
            .unwrap()
            .records
            .iter()
            .find(|job| job.key.request_id == REQUEST)
            .unwrap()
            .io,
        IoState::Unconfirmed
    );
    assert!(owned.entries[0].original_handle.is_some());
    assert_fenced(owned.drain_failed(REQUEST, 4).err().unwrap());
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let reader = owned.reader();
    let (owned, stopped_ok) = std::thread::scope(|scope| {
        let mut release = release;
        let task = scope.spawn(move || {
            let result = owned.stop_retired_owner(REQUEST);
            (owned, result)
        });
        let stop_seen = stopped.recv_timeout(Duration::from_secs(3));
        let joins_before = joins.load(Ordering::SeqCst);
        release.release();
        let result = task.join();
        assert!(stop_seen.is_ok());
        assert_eq!(joins_before, 0);
        result.unwrap()
    });
    stopped_ok.unwrap();
    assert_eq!(
        reader.job(REQUEST).unwrap(),
        recovered,
        "known owner stop cannot ACK recovered job"
    );
    assert_eq!(
        owned
            .coordinator
            .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
            .unwrap()
            .identity,
        original.identity
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    // A fresh boot cannot acquire the surviving original live handle or proof.
    let mut unknown = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    assert_eq!(
        unknown
            .observe_stop(owned.entries[0].original_handle.as_ref().unwrap())
            .err(),
        Some(LeaseError::StaleHandle)
    );
    assert_eq!(reader.job(REQUEST).unwrap()["cleanupPending"], true);
}

// Own the cleanup JoinHandle outside the production supervisor ONLY AFTER Drop.
// A test-driver join is deliberately not Coordinator stop evidence.
struct DropMonitoredStart {
    starts: Arc<AtomicUsize>,
    joins: Arc<AtomicUsize>,
    ready: mpsc::Sender<()>,
    stop_seen: mpsc::Sender<()>,
    exit: mpsc::Receiver<()>,
    orphaned: mpsc::Sender<std::thread::JoinHandle<()>>,
}
struct DropMonitoredOwner {
    thread: Option<std::thread::JoinHandle<()>>,
    stop: Option<mpsc::Sender<()>>,
    joins: Arc<AtomicUsize>,
    orphaned: mpsc::Sender<std::thread::JoinHandle<()>>,
}
impl StartOwnedResource for DropMonitoredStart {
    fn start(self: Box<Self>) -> StartOutcome {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (stop, stopped) = mpsc::channel();
        let ready = self.ready;
        let seen = self.stop_seen;
        let exit = self.exit;
        let thread = std::thread::spawn(move || {
            let _ = ready.send(());
            let _ = stopped.recv();
            let _ = seen.send(());
            let _ = exit.recv();
        });
        StartOutcome::Started(Box::new(DropMonitoredOwner {
            thread: Some(thread),
            stop: Some(stop),
            joins: self.joins,
            orphaned: self.orphaned,
        }))
    }
}
impl OwnedRunningResource for DropMonitoredOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| LeaseError::ResourceStopPending)?;
            self.joins.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}
impl Drop for DropMonitoredOwner {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            // The driver must join it after releasing the gate, never acknowledge it.
            let _ = self.orphaned.send(thread);
        }
    }
}

#[test]
fn scope_supervisor_loss_never_confirms_cleanup_from_drop_or_detached_worker_exit() {
    let (root, mut owned, snapshot) = prepared();
    let starts = Arc::new(AtomicUsize::new(0));
    let joins = Arc::new(AtomicUsize::new(0));
    let (ready, ready_rx) = mpsc::channel();
    let (seen, stopped) = mpsc::channel();
    let (exit, exit_rx) = mpsc::channel();
    let mut release = ExitRelease(Some(exit));
    let (orphaned, driver) = mpsc::channel();
    let action = Box::new(DropMonitoredStart {
        starts: starts.clone(),
        joins: joins.clone(),
        ready,
        stop_seen: seen,
        exit: exit_rx,
        orphaned,
    });
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let reader = owned.reader();
    let before = reader.job(REQUEST).unwrap();
    let mut replacement = update(ProfileKind::ActualRelay, AuthChange::KeepBearer);
    replacement.expected_revision = Some(REVISION.into());
    let saved = owned
        .coordinator
        .configure(ConfigMutation::Put(replacement), ids())
        .unwrap();
    assert!(saved.settings_saved && !saved.cleanup_confirmed);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    let targets_before: String = db
        .query_row(
            "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION],
            |r| r.get(0),
        )
        .unwrap();
    assert!(targets_before.contains(REVISION));
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    let dropper = std::thread::spawn(move || drop(owned));
    // Drop itself is probed off-thread: a defective blocking Drop cannot strand
    // this harness before the driver releases the original exit gate.
    let original_thread = driver.recv_timeout(Duration::from_secs(3));
    let stopped_result = stopped.recv_timeout(Duration::from_secs(3));
    // Release first; even a failing assertion below cannot strand the worker.
    release.release();
    let drop_finished = dropper.join();
    let driver_joined = original_thread.map(|thread| thread.join());
    assert!(drop_finished.is_ok());
    assert!(stopped_result.is_ok());
    assert!(matches!(driver_joined, Ok(Ok(()))));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        joins.load(Ordering::SeqCst),
        0,
        "driver exit observation mints no accepted Coordinator proof"
    );
    assert_eq!(reader.job(REQUEST).unwrap(), before);
    assert_eq!(reader.job(REQUEST).unwrap()["cleanupPending"], true);
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let mut unknown = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let pending = unknown.retry_cleanup(PROFILE, OPERATION).unwrap();
    assert!(pending.settings_saved && !pending.cleanup_confirmed);
    let targets_after: String = db
        .query_row(
            "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        targets_after, targets_before,
        "immutable unknown-boot targets cannot be repaired from job status or thread exit"
    );
}

#[test]
fn undrained_failed_and_unconfirmed_jobs_keep_all128_scope_slots() {
    let (_root, mut owned, snapshot) = prepared();
    let (action, starts, joins, ready, stopped, release) = worker(false);
    owned.begin_owned(REQUEST, &snapshot, action, 1).unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    // Fixture-only child access invokes the real pure queue admission function;
    // no facade method exports a mutable JobStore or starts 127 fake resources.
    {
        let mut store = owned.jobs.lock().unwrap();
        for suffix in 2..=128 {
            let request = format!("50000000-0000-4000-8000-{suffix:012}");
            let queued =
                super::super::begin(&mut store, &scope(), &snapshot, &request, 100).unwrap();
            assert_eq!(queued.io, super::super::IoState::NeverStarted);
        }
        assert_eq!(store.records.len(), 128);
        let original = store
            .records
            .iter()
            .find(|j| j.key.request_id == REQUEST)
            .unwrap()
            .clone();
        let same =
            super::super::begin(&mut store, &scope(), &snapshot, REQUEST, u64::MAX - 1).unwrap();
        assert_eq!(
            same, original,
            "elapsed time never replaces an unresolved same ID"
        );
    }
    let extra = "50000000-0000-4000-8000-000000000129";
    let (unused, extra_starts, _, _, _, _unused_release) = worker(false);
    assert_eq!(
        owned
            .begin_owned(extra, &snapshot, unused, u64::MAX - 1)
            .err(),
        Some(DrainError::Job(Error::JobLimit))
    );
    assert_eq!(extra_starts.load(Ordering::SeqCst), 0);
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    owned.recover_scope(200).unwrap();
    let recovered = owned.reader().job(REQUEST).unwrap();
    assert_eq!(recovered["status"], before["status"]);
    assert_eq!(recovered["error"], before["error"]);
    assert_eq!(recovered["completedMs"], before["completedMs"]);
    assert_eq!(recovered["cleanupPending"], true);
    let (unused, extra_starts, _, _, _, _unused_release) = worker(false);
    assert_eq!(
        owned.begin_owned(extra, &snapshot, unused, 201).err(),
        Some(DrainError::Job(Error::JobLimit))
    );
    assert_eq!(extra_starts.load(Ordering::SeqCst), 0);
    let reader = owned.reader();
    let owned = std::thread::scope(|scope| {
        let mut release = release;
        let task = scope.spawn(move || {
            let result = owned.stop_retired_owner(REQUEST);
            (owned, result)
        });
        let stopped_result = stopped.recv_timeout(Duration::from_secs(3));
        let joins_before = joins.load(Ordering::SeqCst);
        release.release();
        let returned = task.join();
        assert!(stopped_result.is_ok());
        assert_eq!(joins_before, 0);
        let (owned, result) = returned.unwrap();
        result.unwrap();
        owned
    });
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    assert_eq!(
        reader.job(REQUEST).unwrap(),
        recovered,
        "real owner stop cannot restore revoked job drain authority"
    );
    let store = owned.jobs.lock().unwrap();
    assert_eq!(
        store.records.len(),
        128,
        "this phase defines no automatic eviction policy even after actual stop"
    );
    assert_eq!(
        store
            .records
            .iter()
            .filter(|j| j.key.request_id == REQUEST)
            .count(),
        1
    );
    drop(store);

    // Non-recovered positive: exact observed drain after capacity pressure
    // changes only I/O; failed outcome/time and all128 retained slots survive.
    let (_ready_root, mut ready_owned, snapshot) = prepared();
    let (action, starts, joins, ready, _stopped, mut release) = worker(false);
    ready_owned
        .begin_owned(REQUEST, &snapshot, action, 1)
        .unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    ready_owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    {
        let mut store = ready_owned.jobs.lock().unwrap();
        for suffix in 2..=128 {
            let request = format!("50000000-0000-4000-8000-{suffix:012}");
            super::super::begin(&mut store, &scope(), &snapshot, &request, 100).unwrap();
        }
    }
    let before = ready_owned.reader().job(REQUEST).unwrap();
    let (unused, extra_starts, _, _, _, _unused_release) = worker(false);
    assert_eq!(
        ready_owned
            .begin_owned(extra, &snapshot, unused, u64::MAX - 1)
            .err(),
        Some(DrainError::Job(Error::JobLimit))
    );
    assert_eq!(extra_starts.load(Ordering::SeqCst), 0);
    release.release();
    let after = ready_owned.drain_failed(REQUEST, 300).unwrap();
    assert_eq!(after["cleanupPending"], false);
    assert_eq!(after["status"], before["status"]);
    assert_eq!(after["error"], before["error"]);
    assert_eq!(after["completedMs"], before["completedMs"]);
    assert!(after["models"].is_null() && after["receipt"].is_null());
    assert_eq!(ready_owned.jobs.lock().unwrap().records.len(), 128);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
}

struct StopPendingOnceStart(Box<dyn StartOwnedResource>);
struct StopPendingOnceOwner {
    original: Box<dyn OwnedRunningResource>,
    first: bool,
}
impl StartOwnedResource for StopPendingOnceStart {
    fn start(self: Box<Self>) -> StartOutcome {
        let wrap = |owner| {
            Box::new(StopPendingOnceOwner {
                original: owner,
                first: true,
            }) as Box<dyn OwnedRunningResource>
        };
        match self.0.start() {
            StartOutcome::Started(owner) => StartOutcome::Started(wrap(owner)),
            StartOutcome::FailedOwned { error, owner } => StartOutcome::FailedOwned {
                error,
                owner: wrap(owner),
            },
        }
    }
}
impl OwnedRunningResource for StopPendingOnceOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if self.first {
            self.first = false;
            return Err(LeaseError::ResourceStopPending);
        }
        self.original.cancel_and_join()
    }
}

#[test]
fn join_error_preserves_original_handle_owner_and_pending_generation_for_retry() {
    let (root, mut owned, snapshot) = prepared();
    let (original, starts, joins, ready, _stopped, mut release) = worker(false);
    owned
        .begin_owned(
            REQUEST,
            &snapshot,
            Box::new(StopPendingOnceStart(original)),
            1,
        )
        .unwrap();
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let before = owned.reader().job(REQUEST).unwrap();
    let original_view = owned
        .coordinator
        .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
        .unwrap();
    assert_eq!(
        owned.drain_failed(REQUEST, 3).err(),
        Some(DrainError::Lease(LeaseError::ResourceStopPending))
    );
    assert_eq!(owned.reader().job(REQUEST).unwrap(), before);
    assert!(owned.entries[0].original_handle.is_some());
    assert!(owned.entries[0].original_proof.is_none());
    assert_eq!(owned.entries[0].phase, DrainPhase::Unobserved);
    assert_eq!(owned.test_observe_calls(), 1);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    release.release();
    let after = owned.drain_failed(REQUEST, 4).unwrap();
    assert_eq!(after["cleanupPending"], false);
    assert_eq!(after["status"], before["status"]);
    assert_eq!(after["error"], before["error"]);
    assert_eq!(after["completedMs"], before["completedMs"]);
    assert!(after["models"].is_null() && after["receipt"].is_null());
    assert_eq!(
        owned
            .coordinator
            .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
            .unwrap()
            .identity,
        original_view.identity
    );
    assert_eq!(owned.test_observe_calls(), 2);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(joins.load(Ordering::SeqCst), 1);
}

#[test]
fn original_handle_is_retained_before_fallible_bridge_binding_read_or_failure_publication() {
    for point in [
        FailurePoint::AfterHandleRetainedBeforeBindingRead,
        FailurePoint::BeforeFailurePublication,
    ] {
        let (_root, mut owned, snapshot) = prepared();
        let failed_owned = point == FailurePoint::BeforeFailurePublication;
        owned.fail_once(point);
        let (action, starts, joins, ready, stopped, release) = worker(failed_owned);
        assert_eq!(
            owned.begin_owned(REQUEST, &snapshot, action, 1).err(),
            Some(DrainError::Job(Error::PersistenceFailed))
        );
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            owned.failure.is_none(),
            "one-shot hook reached its exact post-retention boundary"
        );
        assert!(owned.entries[0].original_handle.is_some());
        assert!(owned.entries[0].original_proof.is_none());
        assert_eq!(
            owned.entries[0].admission_error,
            if failed_owned {
                Some(LeaseError::HandoffFailed)
            } else {
                None
            }
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(joins.load(Ordering::SeqCst), 0);
        let original_view = owned
            .coordinator
            .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
            .unwrap();
        let pending = owned.reader().job(REQUEST).unwrap();
        assert_eq!(pending["cancelConfirmed"], false);
        assert!(pending["models"].is_null() && pending["receipt"].is_null());
        assert_eq!(
            owned
                .jobs
                .lock()
                .unwrap()
                .records
                .iter()
                .find(|j| j.key.request_id == REQUEST)
                .unwrap()
                .io,
            IoState::Active
        );
        // An error before failure publication can still be Running; existing DTO
        // cleanupPending is defined for terminal/Cancelling only. Never call that
        // status quiescent. Explicit rejection below must expose cleanupPending.
        // Explicit retry only: saved typed failure and original handle already
        // belong to the supervisor; no new admission or substituted owner.
        owned
            .record_rejection(REQUEST, Error::InvalidReceipt, 2)
            .unwrap();
        let before = owned.reader().job(REQUEST).unwrap();
        assert_eq!(before["cleanupPending"], true);
        let (owned, settled) = std::thread::scope(|scope| {
            let mut release = release;
            let task = scope.spawn(move || {
                let result = owned.drain_failed(REQUEST, 3);
                (owned, result)
            });
            let stopped_result = stopped.recv_timeout(Duration::from_secs(3));
            let joins_before = joins.load(Ordering::SeqCst);
            release.release();
            let returned = task.join();
            assert!(stopped_result.is_ok());
            assert_eq!(joins_before, 0);
            let (owned, result) = returned.unwrap();
            (owned, result.unwrap())
        });
        assert_eq!(settled["cleanupPending"], false);
        assert_eq!(settled["status"], "failed");
        assert_eq!(settled["error"], before["error"]);
        assert_eq!(settled["completedMs"], before["completedMs"]);
        assert!(settled["models"].is_null() && settled["receipt"].is_null());
        assert_eq!(
            owned
                .coordinator
                .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
                .unwrap()
                .identity,
            original_view.identity
        );
        assert_eq!(owned.test_observe_calls(), 1);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(joins.load(Ordering::SeqCst), 1);
    }
}

// OD-IMPL-001: selected-scope request selectors must remain unambiguous even
// though the historical pure JobKey intentionally includes a profile ID.
#[test]
fn same_uuid_other_valid_profile_is_rejected_before_insertion_and_original_owner_stays_supervised()
{
    let (root, mut owned, snapshot_a) = prepared();
    let mut request_b = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request_b.profile_id = OTHER_PROFILE.into();
    request_b.operation_id = "60000000-0000-4000-8000-000000000010".into();
    owned
        .coordinator
        .configure(
            ConfigMutation::Put(request_b),
            SaveIds {
                revision: "20000000-0000-4000-8000-000000000010".into(),
                credential_id: "30000000-0000-4000-8000-000000000010".into(),
                credential_generation: "40000000-0000-4000-8000-000000000010".into(),
            },
        )
        .unwrap();
    let profile_b = owned.coordinator.profile(OTHER_PROFILE).unwrap().unwrap();
    let snapshot_b =
        runtime::resolve(&scope(), &profile_b, &reference_for(&profile_b), None).unwrap();
    assert_ne!(
        snapshot_a.reference.profile_id,
        snapshot_b.reference.profile_id
    );
    assert_eq!(snapshot_a.reference.scope, snapshot_b.reference.scope);

    let (action_a, starts_a, joins_a, ready_a, stopped_a, release_a) = worker(false);
    owned
        .begin_owned(REQUEST, &snapshot_a, action_a, 1)
        .unwrap();
    ready_a.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let records_before = owned.jobs.lock().unwrap().records.clone();
    let next_generation_before = owned.jobs.lock().unwrap().next_generation;
    let original_dto = owned.reader().job(REQUEST).unwrap();
    let original_view = owned
        .coordinator
        .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
        .unwrap();
    let original_generation = owned.entries[0].permit.generation;
    assert_eq!(records_before.len(), 1);
    assert_eq!(records_before[0].io, IoState::Active);
    assert_eq!(original_dto["status"], "failed");
    assert_eq!(original_dto["cleanupPending"], true);

    let (action_b, starts_conflict, joins_conflict, _ready_b, _stopped_b, mut release_b) =
        worker(false);
    let conflict_error = owned.begin_owned(REQUEST, &snapshot_b, action_b, 3).err();
    let records_after_conflict = owned.jobs.lock().unwrap().records.clone();
    let entries_after_conflict = owned.entries.len();
    let next_generation_after_conflict = owned.jobs.lock().unwrap().next_generation;
    let reader_after_conflict = owned.reader().job(REQUEST);
    let original_handle_after_conflict = owned
        .coordinator
        .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
        .unwrap();
    let original_generation_after_conflict = owned.entries[0].permit.generation;
    // Exact original retry must be lookup-only even while failed I/O is Active.
    let (same_action, starts_same, joins_same, _same_ready, _same_stopped, mut same_release) =
        worker(false);
    let exact_retry = owned.begin_owned(REQUEST, &snapshot_a, same_action, 4);
    let records_after_exact_retry = owned.jobs.lock().unwrap().records.clone();

    let (mut owned, normal_drain, stop_seen, joins_before_release) = std::thread::scope(|scope| {
        let mut release_a = release_a;
        let task = scope.spawn(move || {
            let result = owned.drain_failed(REQUEST, 5);
            (owned, result)
        });
        let stop_seen = stopped_a.recv_timeout(Duration::from_secs(3));
        let joins_before = joins_a.load(Ordering::SeqCst);
        // Release before assertions/join, including when the poisoned selector
        // returned early without cancelling its still-owned original resource.
        release_a.release();
        let returned = task.join().unwrap();
        (returned.0, returned.1, stop_seen, joins_before)
    });
    release_b.release();
    same_release.release();
    // Teardown only: cleanup any genuine original resource before causal asserts
    // even if normal drain failed. No phase/job CAS is performed by this helper;
    // it cannot turn a failed normal-drain observation into a passing result.
    for index in 0..owned.entries.len() {
        if owned.entries[index].original_handle.is_none() {
            continue;
        }
        if owned.entries[index].original_proof.is_none() {
            let proof = owned
                .coordinator
                .observe_stop(owned.entries[index].original_handle.as_ref().unwrap())
                .unwrap();
            owned.entries[index].original_proof = Some(proof);
        }
        owned
            .coordinator
            .release_completed(
                owned.entries[index].original_handle.as_ref().unwrap(),
                owned.entries[index].original_proof.as_ref().unwrap(),
            )
            .unwrap();
    }

    // Current defective source inserts B/R: this first causal assertion must fail
    // after owned cleanup, rather than masking it behind a different error family.
    assert_eq!(
        records_after_conflict, records_before,
        "cross-profile UUID rejection must precede ANY second JobStore insertion"
    );
    assert_eq!(entries_after_conflict, 1);
    assert_eq!(next_generation_after_conflict, next_generation_before);
    assert_eq!(
        conflict_error,
        Some(DrainError::Job(Error::DiscoveryConflict))
    );
    assert_eq!(starts_conflict.load(Ordering::SeqCst), 0);
    assert_eq!(joins_conflict.load(Ordering::SeqCst), 0);
    assert_eq!(reader_after_conflict.unwrap(), original_dto);
    assert_eq!(original_handle_after_conflict, original_view);
    assert_eq!(original_generation_after_conflict, original_generation);
    assert_eq!(exact_retry, Ok(()));
    assert_eq!(records_after_exact_retry, records_before);
    assert_eq!(starts_same.load(Ordering::SeqCst), 0);
    assert_eq!(joins_same.load(Ordering::SeqCst), 0);
    assert!(
        stop_seen.is_ok(),
        "normal original route still reached actual original cancellation"
    );
    assert_eq!(joins_before_release, 0);
    let drained_a = normal_drain.unwrap();
    assert_eq!(drained_a["cleanupPending"], false);
    assert_eq!(drained_a["status"], original_dto["status"]);
    assert_eq!(drained_a["error"], original_dto["error"]);
    assert_eq!(drained_a["completedMs"], original_dto["completedMs"]);
    assert!(drained_a["models"].is_null() && drained_a["receipt"].is_null());
    assert_eq!(starts_a.load(Ordering::SeqCst), 1);
    assert_eq!(joins_a.load(Ordering::SeqCst), 1);
    assert_eq!(
        owned.test_observe_calls(),
        1,
        "normal bridge drain observed the original owner; teardown is not a substitute"
    );
    assert_eq!(
        owned
            .coordinator
            .lease_view(owned.entries[0].original_handle.as_ref().unwrap())
            .unwrap()
            .identity,
        original_view.identity
    );

    // B is valid: a different request UUID admits, starts and drains normally.
    let (action_b, starts_b, joins_b, ready_b, _stopped_b, mut release_b) = worker(false);
    owned
        .begin_owned(SECOND_REQUEST, &snapshot_b, action_b, 6)
        .unwrap();
    ready_b.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(SECOND_REQUEST, Error::InvalidReceipt, 7)
        .unwrap();
    release_b.release();
    let drained_b = owned.drain_failed(SECOND_REQUEST, 8).unwrap();
    assert_eq!(drained_b["profileId"], OTHER_PROFILE);
    assert_eq!(drained_b["requestId"], SECOND_REQUEST);
    assert_eq!(drained_b["cleanupPending"], false);
    assert_eq!(starts_b.load(Ordering::SeqCst), 1);
    assert_eq!(joins_b.load(Ordering::SeqCst), 1);
    assert_eq!(owned.reader().job(REQUEST).unwrap(), drained_a);
    assert_eq!(owned.entries.len(), 2);
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM provider_connection_actors", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2,
        "only A/R and B/different-R were ever admitted"
    );
}

// UNAPPLIED append to existing jobs::owned_discovery::tests, reusing its REAL
// prepared()/worker() fixtures/imports. Current signatures/types only. No new port
// is needed to compile this proposed first test; root has not applied or run it.
// Source predicts the IoState assertion fails Active != NeverStarted. A callback
// counter or SQL absence is fixture evidence, NEVER the producer's proof authority.
#[test]
fn registration_insert_abort_never_dispatches_and_does_not_wait_forever_for_an_absent_owner() {
    let (root, mut owned, snapshot) = prepared();
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    db.execute_batch("CREATE TRIGGER never_dispatch_abort BEFORE INSERT ON provider_connection_actors BEGIN SELECT RAISE(ABORT,'synthetic registration failure'); END;").unwrap();
    let (action, starts, joins, _ready, _stopped, mut release) = worker(false);
    let error = owned.begin_owned(REQUEST, &snapshot, action, 1).err();
    release.release(); // No worker has been started on this exact current path.
    assert_eq!(
        error,
        Some(DrainError::Lease(LeaseError::PersistenceFailed))
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    assert!(owned.entries[0].original_handle.is_none());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM provider_connection_actors", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    {
        let store = owned.jobs.lock().unwrap();
        let job = store
            .records
            .iter()
            .find(|j| j.key.request_id == REQUEST)
            .unwrap();
        assert_eq!(job.status, Status::Failed);
        // Existing enum, not a manufactured missing-variant compile failure.
        assert_eq!(job.io, IoState::NeverStarted);
        assert!(job.worker_generation.is_none());
        assert!(store
            .pending_io
            .iter()
            .all(|pending| pending.key != job.key));
    }
    let failed = owned.reader().job(REQUEST).unwrap();
    assert_eq!(failed["cleanupPending"], false);
    assert_eq!(failed["cancelConfirmed"], false);
    assert_eq!(failed["error"]["code"], "admission_rejected");
    assert!(failed["models"].is_null() && failed["receipt"].is_null());
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER never_dispatch_abort")
        .unwrap();
}

// UNAPPLIED append to existing jobs::owned_discovery::tests. Five future cases
// ND02/03/04/06/07 plus helpers; ND05 belongs in leases::tests separately.
// Uses the proposed private ports/field/phase names, NOT current compilable API.
// No source import, producer, stub or runtime exists in this preview.

fn no_start_abort(root: &std::path::Path) {
    rusqlite::Connection::open(root.join(storage::DATABASE_FILE)).unwrap().execute_batch(
        "CREATE TRIGGER no_start_test_abort BEFORE INSERT ON provider_connection_actors BEGIN SELECT RAISE(ABORT,'synthetic registration failure'); END;"
    ).unwrap();
}
fn pending_original_no_start() -> (
    tempfile::TempDir,
    OwnedDiscovery,
    EffectiveConnection,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let (root, mut owned, snapshot) = prepared();
    no_start_abort(root.path());
    owned.fail_once(FailurePoint::AfterNeverDispatchedRetainedBeforeJobCas);
    let (action, starts, joins, _ready, _stopped, mut release) = worker(false);
    let error = owned.begin_owned(REQUEST, &snapshot, action, 1).err();
    release.release();
    assert_eq!(error, Some(DrainError::Job(Error::PersistenceFailed)));
    assert!(owned.entries[0].original_never_dispatched.is_some());
    assert!(owned.entries[0].original_handle.is_none());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE))
        .unwrap()
        .execute_batch("DROP TRIGGER no_start_test_abort;")
        .unwrap();
    (root, owned, snapshot, starts, joins)
}
fn no_start_target(owned: &OwnedDiscovery, index: usize) -> NeverDispatchTarget {
    let entry = &owned.entries[index];
    NeverDispatchTarget {
        store_identity: entry.permit.store_identity.clone(),
        key: entry.permit.key.clone(),
        generation: entry.permit.generation,
        snapshot: entry.snapshot.clone(),
    }
}
fn cohere_no_start(target: &mut NeverDispatchTarget) {
    let snapshot = &mut target.snapshot;
    let expected = CredentialTarget {
        scope: snapshot.reference.scope.clone(),
        profile_id: snapshot.reference.profile_id.clone(),
        kind: snapshot.kind,
        base_url: snapshot.base_url.clone(),
        transport: snapshot.transport,
    };
    match &mut snapshot.auth {
        StoredAuth::None => {
            snapshot.reference.credential_id = None;
            snapshot.reference.credential_generation = None;
        }
        StoredAuth::Bearer(binding) => {
            binding.target = expected;
            snapshot.reference.credential_id = Some(binding.id.clone());
            snapshot.reference.credential_generation = Some(binding.generation.clone());
        }
    }
}

#[test]
fn preflight_replacement_never_dispatches_current_attempt_or_acknowledges_old_actor() {
    let (root, mut owned, snapshot) = prepared();
    let (old_action, old_starts, old_joins, old_ready, _old_stopped, mut old_exit) = worker(false);
    owned
        .begin_owned(REQUEST, &snapshot, old_action, 1)
        .unwrap();
    old_ready.recv_timeout(Duration::from_secs(3)).unwrap();
    owned
        .record_rejection(REQUEST, Error::InvalidReceipt, 2)
        .unwrap();
    let (reached, reached_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    owned.test_pause_after_dispatch(reached, release_rx);
    let mut admission_release = ExitRelease(Some(release));
    let (action, starts, joins, _ready, _stopped, mut new_exit) = worker(false);
    let mut other = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    let (mut owned, failure, reached_ok, saved, targets_before) = std::thread::scope(|scope| {
        let thread = scope.spawn(move || {
            let failure = owned.begin_owned(SECOND_REQUEST, &snapshot, action, 3);
            (owned, failure)
        });
        let reached_ok = reached_rx.recv_timeout(Duration::from_secs(3));
        let mut replacement = update(ProfileKind::ActualRelay, AuthChange::KeepBearer);
        replacement.expected_revision = Some(REVISION.into());
        let saved = other.configure(ConfigMutation::Put(replacement), ids());
        let targets_before = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).and_then(|db| db.query_row("SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1", [OPERATION], |r| r.get::<_,String>(0)));
        // Release before assertions/joins, even if mutation or rendezvous failed.
        admission_release.release();
        old_exit.release();
        new_exit.release();
        let returned = thread.join();
        let (owned, failure) = returned.unwrap();
        (owned, failure, reached_ok, saved, targets_before)
    });
    let targets_after = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE))
        .and_then(|db| {
            db.query_row(
                "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
                [OPERATION],
                |r| r.get::<_, String>(0),
            )
        });
    let check_db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE));
    let facts_before_old_join = check_db.and_then(|db| {
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0),
        )
    });
    let new_result = owned.reader().job(SECOND_REQUEST);
    let old_result = owned.reader().job(REQUEST);
    let pending_before_old_join = owned.coordinator.operation_status(PROFILE, OPERATION);
    let old_joins_before = old_joins.load(Ordering::SeqCst);
    // Original old-owner route is still required, not a no-start/global ACK.
    let old_drained = owned.drain_failed(REQUEST, 4);
    // Teardown only for faulty future source: do not substitute it for the
    // captured normal drain result, and never settle a job/phase in teardown.
    for i in 0..owned.entries.len() {
        if owned.entries[i].original_handle.is_none() {
            continue;
        }
        if owned.entries[i].original_proof.is_none() {
            let proof = owned
                .coordinator
                .observe_stop(owned.entries[i].original_handle.as_ref().unwrap())
                .unwrap();
            owned.entries[i].original_proof = Some(proof);
        }
        owned
            .coordinator
            .release_completed(
                owned.entries[i].original_handle.as_ref().unwrap(),
                owned.entries[i].original_proof.as_ref().unwrap(),
            )
            .unwrap();
    }
    assert!(reached_ok.is_ok());
    assert!(saved.unwrap().settings_saved);
    assert_eq!(
        targets_after.unwrap(),
        targets_before.unwrap(),
        "current no-start proof must not alter immutable old actor targets"
    );
    assert_eq!(facts_before_old_join.unwrap(), 0);
    assert!(matches!(
        failure.err(),
        Some(DrainError::Lease(
            LeaseError::ConfigurationChanged | LeaseError::CleanupPending
        ))
    ));
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    let current = new_result.unwrap();
    assert_eq!(current["cleanupPending"], false);
    assert_eq!(current["error"]["code"], "admission_rejected");
    assert_eq!(
        owned
            .jobs
            .lock()
            .unwrap()
            .records
            .iter()
            .find(|j| j.key.request_id == SECOND_REQUEST)
            .unwrap()
            .io,
        IoState::NeverStarted
    );
    assert_eq!(old_result.unwrap()["cleanupPending"], true);
    assert!(!pending_before_old_join.unwrap().cleanup_confirmed);
    assert_eq!(old_joins_before, 0);
    assert_eq!(old_drained.unwrap()["cleanupPending"], false);
    assert_eq!(old_starts.load(Ordering::SeqCst), 1);
    assert_eq!(old_joins.load(Ordering::SeqCst), 1);
}

#[test]
fn saved_original_no_start_capability_retries_exact_job_cas_without_readmit_or_io() {
    let (_root, mut owned, snapshot, starts, joins) = pending_original_no_start();
    let before = owned.reader().job(REQUEST).unwrap();
    assert_eq!(owned.jobs.lock().unwrap().records[0].io, IoState::Active);
    let target = no_start_target(&owned, 0);
    let failed = owned.drain_failed(REQUEST, 2).unwrap();
    assert_eq!(failed["cleanupPending"], false);
    assert_eq!(failed["cancelConfirmed"], false);
    assert_eq!(
        owned.jobs.lock().unwrap().records[0].io,
        IoState::NeverStarted
    );
    assert_eq!(failed["error"]["code"], "admission_rejected");
    assert_eq!(
        failed["completedMs"], 1,
        "original failed-admission timestamp is retained before CAS retry"
    );
    assert_eq!(owned.drain_failed(REQUEST, 3).unwrap(), failed);
    let mut wrong = no_start_target(&owned, 0);
    wrong.generation += 1;
    let records_before = owned.jobs.lock().unwrap().records.clone();
    assert_fenced(
        owned
            .test_settle_never_dispatched_target(0, &wrong, 4)
            .err()
            .unwrap(),
    );
    assert_eq!(owned.jobs.lock().unwrap().records, records_before);
    assert_eq!(
        owned
            .test_settle_never_dispatched_target(0, &target, 5)
            .unwrap(),
        failed
    );
    assert_eq!(owned.test_observe_calls(), 0);
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    assert!(before["models"].is_null() && failed["models"].is_null());
    // Existing bounded slot accounting is retained even after proved no-start.
    {
        let mut jobs = owned.jobs.lock().unwrap();
        for n in 2..=128 {
            let request = format!("50000000-0000-4000-8000-{n:012}");
            super::super::begin(&mut jobs, &scope(), &snapshot, &request, 6).unwrap();
        }
    }
    let (action, extra_starts, _, _, _, _exit) = worker(false);
    assert_eq!(
        owned
            .begin_owned("50000000-0000-4000-8000-000000000129", &snapshot, action, 7)
            .err(),
        Some(DrainError::Job(Error::JobLimit))
    );
    assert_eq!(extra_starts.load(Ordering::SeqCst), 0);
    assert_eq!(owned.reader().job(REQUEST).unwrap(), failed);
}

#[test]
fn genuine_original_no_start_proof_rejects_each_valid_foreign_binding_then_restores_original() {
    for field in [
        "store",
        "owner",
        "environment",
        "profile",
        "request",
        "generation",
        "revision",
        "credential",
        "credential-generation",
        "endpoint",
        "kind-derived-transport",
        "auth-mode",
        "cluster",
    ] {
        let (root, mut owned, snapshot) = match field {
            "endpoint" | "auth-mode" => prepared_kind(ProfileKind::LmStudioLocal, true),
            "kind-derived-transport" => prepared_kind(ProfileKind::ActualLocal, false),
            _ => prepared(),
        };
        no_start_abort(root.path());
        owned.fail_once(FailurePoint::AfterNeverDispatchedRetainedBeforeJobCas);
        let (action, starts, joins, _ready, _stopped, mut exit) = worker(false);
        let failure = owned.begin_owned(REQUEST, &snapshot, action, 1).err();
        exit.release();
        assert_eq!(failure, Some(DrainError::Job(Error::PersistenceFailed)));
        assert!(owned.entries[0].original_never_dispatched.is_some());
        assert!(owned.entries[0].original_handle.is_none());
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(joins.load(Ordering::SeqCst), 0);
        rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE))
            .unwrap()
            .execute_batch("DROP TRIGGER no_start_test_abort;")
            .unwrap();
        let original = no_start_target(&owned, 0);
        let mut wrong = no_start_target(&owned, 0);
        match field {
            "store" => wrong.store_identity = Arc::new(()),
            "owner" => {
                wrong.key.scope.owner_id = "other-owner".into();
                wrong.snapshot.reference.scope = wrong.key.scope.clone();
            }
            "environment" => {
                wrong.key.scope.environment_id = "other-environment".into();
                wrong.snapshot.reference.scope = wrong.key.scope.clone();
            }
            "profile" => {
                wrong.key.profile_id = OTHER_PROFILE.into();
                wrong.snapshot.reference.profile_id = OTHER_PROFILE.into();
            }
            "request" => wrong.key.request_id = SECOND_REQUEST.into(),
            "generation" => wrong.generation += 1,
            "revision" => wrong.snapshot.reference.revision = NEXT_REVISION.into(),
            "credential" => {
                if let StoredAuth::Bearer(binding) = &mut wrong.snapshot.auth {
                    binding.id = NEXT_CREDENTIAL.into();
                }
            }
            "credential-generation" => {
                if let StoredAuth::Bearer(binding) = &mut wrong.snapshot.auth {
                    binding.generation = NEXT_GENERATION.into();
                }
            }
            "endpoint" => wrong.snapshot.base_url = "http://127.0.0.1:1235/v1".into(),
            "kind-derived-transport" => {
                wrong.snapshot.kind = ProfileKind::LmStudioLocal;
                wrong.snapshot.transport = Transport::OpenAiChat;
            }
            "auth-mode" => wrong.snapshot.auth = StoredAuth::None,
            _ => wrong.snapshot.cluster_id = Some("other-cluster".into()),
        }
        cohere_no_start(&mut wrong);
        super::super::validate_key(&wrong.key).unwrap();
        let independent = profile_from_snapshot(&wrong.snapshot);
        assert_eq!(
            runtime::resolve(
                &independent.scope,
                &independent,
                &wrong.snapshot.reference,
                None
            )
            .unwrap(),
            wrong.snapshot
        );
        let before = owned.jobs.lock().unwrap().records.clone();
        assert_fenced(
            owned
                .test_settle_never_dispatched_target(0, &wrong, 2)
                .err()
                .unwrap(),
        );
        assert_eq!(owned.jobs.lock().unwrap().records, before);
        // Genuine original token is opaque and cannot be provided to the CAS.
        let token = owned.entries[0].original_never_dispatched.as_ref().unwrap();
        // V2 ND-PREVIEW-002: coordinator full-snapshot binding is tested directly;
        // a stronger bridge CAS must not mask a verifier ignoring these fields.
        if wrong.snapshot != snapshot {
            assert_eq!(
                owned
                    .coordinator
                    .verify_never_dispatched(
                        token,
                        REQUEST,
                        &wrong.snapshot,
                        ConsumerKind::Discovery
                    )
                    .err(),
                Some(LeaseError::InvalidEvidence),
                "{field}: originating verifier must reject changed valid full snapshot"
            );
        }
        let fresh = Coordinator::open(
            root.path(),
            TrustedExecutionContext::from_authenticated_execution(scope()),
        )
        .unwrap();
        assert_eq!(
            fresh
                .verify_never_dispatched(token, REQUEST, &snapshot, ConsumerKind::Discovery)
                .err(),
            Some(LeaseError::InvalidEvidence)
        );
        assert_eq!(
            owned
                .coordinator
                .verify_never_dispatched(token, REQUEST, &snapshot, ConsumerKind::Cli)
                .err(),
            Some(LeaseError::InvalidEvidence)
        );
        owned
            .coordinator
            .verify_never_dispatched(token, REQUEST, &snapshot, ConsumerKind::Discovery)
            .unwrap();
        assert_eq!(
            owned
                .test_settle_never_dispatched_target(0, &original, 3)
                .unwrap()["cleanupPending"],
            false
        );
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(joins.load(Ordering::SeqCst), 0);
    }
    // Two original returned proof objects: neither may settle the other attempt.
    let (root, mut owned, snapshot, _, _) = pending_original_no_start();
    no_start_abort(root.path());
    owned.fail_once(FailurePoint::AfterNeverDispatchedRetainedBeforeJobCas);
    let (action, second_starts, second_joins, _ready, _stopped, mut exit) = worker(false);
    let error = owned
        .begin_owned(SECOND_REQUEST, &snapshot, action, 2)
        .err();
    exit.release();
    assert_eq!(error, Some(DrainError::Job(Error::PersistenceFailed)));
    let token_a = owned.entries[0].original_never_dispatched.as_ref().unwrap();
    let token_b = owned.entries[1].original_never_dispatched.as_ref().unwrap();
    assert_eq!(
        owned
            .coordinator
            .verify_never_dispatched(token_a, SECOND_REQUEST, &snapshot, ConsumerKind::Discovery)
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
    assert_eq!(
        owned
            .coordinator
            .verify_never_dispatched(token_b, REQUEST, &snapshot, ConsumerKind::Discovery)
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
    owned
        .coordinator
        .verify_never_dispatched(token_a, REQUEST, &snapshot, ConsumerKind::Discovery)
        .unwrap();
    owned
        .coordinator
        .verify_never_dispatched(token_b, SECOND_REQUEST, &snapshot, ConsumerKind::Discovery)
        .unwrap();
    let original_a = no_start_target(&owned, 0);
    let original_b = no_start_target(&owned, 1);
    let before = owned.jobs.lock().unwrap().records.clone();
    assert_fenced(
        owned
            .test_settle_never_dispatched_target(0, &original_b, 3)
            .err()
            .unwrap(),
    );
    assert_eq!(owned.jobs.lock().unwrap().records, before);
    owned
        .test_settle_never_dispatched_target(0, &original_a, 4)
        .unwrap();
    owned
        .test_settle_never_dispatched_target(1, &original_b, 4)
        .unwrap();
    assert_eq!(second_starts.load(Ordering::SeqCst), 0);
    assert_eq!(second_joins.load(Ordering::SeqCst), 0);
    assert_eq!(owned.test_observe_calls(), 0);
    assert_eq!(
        rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM provider_connection_actors", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

struct InertNoStartAction {
    original: Option<Box<dyn StartOwnedResource>>,
    dropped: Arc<AtomicUsize>,
}
impl StartOwnedResource for InertNoStartAction {
    fn start(mut self: Box<Self>) -> StartOutcome {
        self.original.take().unwrap().start()
    }
}
impl Drop for InertNoStartAction {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
#[test]
fn token_drop_legacy_extraction_and_prepared_action_lifetime_do_not_create_stop_authority() {
    let (root, mut owned, snapshot) = prepared();
    no_start_abort(root.path());
    owned.fail_once(FailurePoint::AfterNeverDispatchedRetainedBeforeJobCas);
    let dropped = Arc::new(AtomicUsize::new(0));
    let (original, starts, joins, _ready, _stopped, mut exit) = worker(false);
    let action = Box::new(InertNoStartAction {
        original: Some(original),
        dropped: dropped.clone(),
    });
    let result = owned.begin_owned(REQUEST, &snapshot, action, 1);
    exit.release();
    assert_eq!(
        result.err(),
        Some(DrainError::Job(Error::PersistenceFailed))
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
    let reader = owned.reader();
    let request_result = reader.job(REQUEST).unwrap();
    drop(request_result);
    drop(reader);
    assert!(owned.entries[0].original_never_dispatched.is_some());
    assert_eq!(
        owned.drain_failed(REQUEST, 2).unwrap()["cleanupPending"],
        false
    );

    // Lose only genuine token on a separate original attempt. No error/row/status
    // may reconstruct it; selected I/O remains unresolved, not a no-op owner.
    let (_root, mut lost, _snapshot, _starts, _joins) = pending_original_no_start();
    drop(lost.entries[0].original_never_dispatched.take());
    assert!(lost.drain_failed(REQUEST, 3).is_err());
    assert_eq!(lost.jobs.lock().unwrap().records[0].io, IoState::Active);
    assert_eq!(lost.test_observe_calls(), 0);
    assert!(lost.entries[0].original_handle.is_none());
    // Legacy extraction compatibility and callback-entered ownership are concrete
    // in ND05; None alone cannot pass this CAS and there is no token constructor.
}

#[test]
fn recovery_and_ambiguous_registration_keep_old_boot_targets_unconfirmed() {
    let (root, mut owned, snapshot, starts, joins) = pending_original_no_start();
    let mut other = snapshot.clone();
    other.reference.scope.owner_id = "other-owner".into();
    if let StoredAuth::Bearer(binding) = &mut other.auth {
        binding.target.scope = other.reference.scope.clone();
    }
    let other_job = super::super::begin(
        &mut owned.jobs.lock().unwrap(),
        &other.reference.scope,
        &other,
        SECOND_REQUEST,
        1,
    )
    .unwrap();
    owned.recover_scope(2).unwrap();
    assert_eq!(
        owned
            .jobs
            .lock()
            .unwrap()
            .records
            .iter()
            .find(|j| j.key == other_job.key)
            .unwrap(),
        &other_job
    );
    let unknown = owned.reader().job(REQUEST).unwrap();
    assert_eq!(
        owned.jobs.lock().unwrap().records[0].io,
        IoState::Unconfirmed
    );
    assert_fenced(owned.drain_failed(REQUEST, 3).err().unwrap());
    assert_eq!(owned.reader().job(REQUEST).unwrap(), unknown);
    let fresh = Coordinator::open(
        root.path(),
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap();
    assert_eq!(
        fresh
            .verify_never_dispatched(
                owned.entries[0].original_never_dispatched.as_ref().unwrap(),
                REQUEST,
                &snapshot,
                ConsumerKind::Discovery
            )
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);

    // Real registration commit THEN injected error before handle/callback. Proved
    // current nonentry does not acknowledge that unknown durable actor or target.
    let (root, mut committed, snapshot) = prepared();
    committed
        .coordinator
        .test_fail_after_registration_commit_before_ownership_retention();
    let (action, starts, joins, _ready, _stopped, mut exit) = worker(false);
    let failure = committed.begin_owned(REQUEST, &snapshot, action, 1).err();
    exit.release();
    assert_eq!(
        failure,
        Some(DrainError::Lease(LeaseError::PersistenceFailed))
    );
    let failed = committed.reader().job(REQUEST).unwrap();
    assert_eq!(failed["cleanupPending"], false);
    assert_eq!(
        committed.jobs.lock().unwrap().records[0].io,
        IoState::NeverStarted
    );
    let db = rusqlite::Connection::open(root.path().join(storage::DATABASE_FILE)).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM provider_connection_actors", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    // V2 ND-PREVIEW-004: data-only capture of the ACTUAL committed actor tuple;
    // this is an assertion oracle, never a new producer proof/capability.
    let (actual_reference_json, actual_actor, actual_boot, actual_lease): (String, String, String, String) = db.query_row("SELECT reference_json,actor_id,process_instance_id,lease_id FROM provider_connection_actors", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    let actual_reference: serde_json::Value = serde_json::from_str(&actual_reference_json).unwrap();
    assert_eq!(
        actual_reference,
        serde_json::json!([
            "v4.connection-ref.v1",
            snapshot.reference.scope.owner_id,
            snapshot.reference.scope.environment_id,
            snapshot.reference.profile_id,
            snapshot.reference.revision,
            snapshot.reference.credential_id,
            snapshot.reference.credential_generation
        ])
    );
    let expected_target = serde_json::json!([
        "v4.revocation-set.v1",
        [[
            actual_reference,
            [[actual_actor, actual_boot, actual_lease]]
        ]]
    ]);
    let mut replacement = update(ProfileKind::ActualRelay, AuthChange::KeepBearer);
    replacement.expected_revision = Some(REVISION.into());
    let saved = committed
        .coordinator
        .configure(ConfigMutation::Put(replacement), ids())
        .unwrap();
    assert!(saved.settings_saved && !saved.cleanup_confirmed);
    let before: String = db
        .query_row(
            "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&before).unwrap(),
        expected_target,
        "the retained target is the exact actual committed full reference/boot/actor/lease"
    );
    assert!(
        !committed
            .coordinator
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    let after: String = db
        .query_row(
            "SELECT revocations_json FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    committed.recover_scope(4).unwrap();
    assert_eq!(
        committed.jobs.lock().unwrap().records[0].io,
        IoState::NeverStarted
    );
    assert_eq!(committed.reader().job(REQUEST).unwrap(), failed);
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(joins.load(Ordering::SeqCst), 0);
}
