use super::*;
use crate::{
    fixtures::*,
    storage::{FeatureStorage, DATABASE_FILE, KEY_FILE},
};
use rusqlite::params;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
use tempfile::TempDir;

const CREATE_OP: &str = "60000000-0000-4000-8000-000000000009";
const DELETE_OP: &str = "60000000-0000-4000-8000-000000000002";
const REQUEST_A: &str = "50000000-0000-4000-8000-000000000001";
const REQUEST_B: &str = "50000000-0000-4000-8000-000000000002";
const THIRD_REVISION: &str = "20000000-0000-4000-8000-000000000003";

#[test]
fn forgetting_a_completed_owner_requires_its_original_proof_and_exact_durable_fact() {
    let (root, mut coordinator, snapshot) = relay();
    let counts = Arc::new(Counters::default());
    let handle = coordinator
        .admit(
            REQUEST_A,
            &snapshot,
            ConsumerKind::StructuredTurn,
            Box::new(FakeStart(counts.clone())),
        )
        .unwrap();
    let proof = coordinator.observe_stop(&handle).unwrap();
    assert_eq!(
        coordinator.forget_completed(&handle, &proof),
        Err(LeaseError::InvalidEvidence)
    );
    assert_eq!(coordinator.resources.len(), 1);
    coordinator.release_completed(&handle, &proof).unwrap();
    let db = database(root.path());
    let original: String = db
        .query_row(
            "SELECT stop_evidence_json FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json='{}'",
        [],
    )
    .unwrap();
    assert_eq!(
        coordinator.forget_completed(&handle, &proof),
        Err(LeaseError::InvalidEvidence)
    );
    assert_eq!(coordinator.resources.len(), 1);
    db.execute(
        "UPDATE provider_connection_actors SET stop_evidence_json=?1",
        [&original],
    )
    .unwrap();
    coordinator.forget_completed(&handle, &proof).unwrap();
    assert!(coordinator.resources.is_empty());
    assert_eq!(counts.joins.load(Ordering::SeqCst), 1);
    assert_eq!(
        coordinator.forget_completed(&handle, &proof),
        Err(LeaseError::InvalidEvidence)
    );
    let retained: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE stop_evidence_json=?1",
            [&original],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1);
}

#[test]
fn another_coordinator_cannot_retire_a_handle_or_proof_it_does_not_own() {
    let (root, mut first, snapshot) = relay();
    let counts = Arc::new(Counters::default());
    let handle = first
        .admit(
            REQUEST_A,
            &snapshot,
            ConsumerKind::StructuredTurn,
            Box::new(FakeStart(counts)),
        )
        .unwrap();
    let proof = first.observe_stop(&handle).unwrap();
    first.release_completed(&handle, &proof).unwrap();
    let mut other = open(root.path());
    assert_eq!(
        other.forget_completed(&handle, &proof),
        Err(LeaseError::InvalidEvidence)
    );
    assert_eq!(first.resources.len(), 1);
    first.forget_completed(&handle, &proof).unwrap();
    assert!(first.resources.is_empty());
}

fn private_root() -> TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
fn open(root: &std::path::Path) -> Coordinator {
    Coordinator::open(
        root,
        TrustedExecutionContext::from_authenticated_execution(scope()),
    )
    .unwrap()
}
fn database(root: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(root.join(DATABASE_FILE)).unwrap()
}
fn configure_relay(coordinator: &mut Coordinator) -> EffectiveConnection {
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.operation_id = CREATE_OP.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    let receipt = coordinator
        .configure(ConfigMutation::Put(request), save)
        .unwrap();
    assert!(receipt.settings_saved && receipt.cleanup_confirmed);
    snapshot(coordinator)
}
fn relay() -> (TempDir, Coordinator, EffectiveConnection) {
    let root = private_root();
    let mut coordinator = open(root.path());
    let effective = configure_relay(&mut coordinator);
    (root, coordinator, effective)
}
fn snapshot(coordinator: &Coordinator) -> EffectiveConnection {
    let profile = coordinator.profile(PROFILE).unwrap().unwrap();
    runtime::resolve(&scope(), &profile, &reference_for(&profile), None).unwrap()
}
fn replacement() -> ConfigMutation {
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.expected_revision = Some(REVISION.into());
    ConfigMutation::Put(request)
}
fn replace(coordinator: &mut Coordinator) -> ConfigReceipt {
    coordinator.configure(replacement(), ids()).unwrap()
}
#[derive(Default)]
struct Counters {
    starts: AtomicUsize,
    joins: AtomicUsize,
    blocked: AtomicBool,
}
struct FakeStart(Arc<Counters>);
struct FakeRunning(Arc<Counters>);
impl StartOwnedResource for FakeStart {
    fn start(self: Box<Self>) -> StartOutcome {
        self.0.starts.fetch_add(1, Ordering::SeqCst);
        StartOutcome::Started(Box::new(FakeRunning(self.0)))
    }
}
impl OwnedRunningResource for FakeRunning {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if self.0.blocked.load(Ordering::SeqCst) {
            return Err(LeaseError::ResourceStopPending);
        }
        self.0.joins.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn action(counters: &Arc<Counters>) -> Box<dyn StartOwnedResource> {
    Box::new(FakeStart(counters.clone()))
}
fn admit(
    coordinator: &mut Coordinator,
    effective: &EffectiveConnection,
    request: &str,
    counters: &Arc<Counters>,
) -> LeaseHandle {
    coordinator
        .admit(
            request,
            effective,
            ConsumerKind::StructuredTurn,
            action(counters),
        )
        .unwrap()
}
fn actor_count(root: &std::path::Path) -> i64 {
    database(root)
        .query_row(
            "SELECT COUNT(*) FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap()
}
fn operation_targets(root: &std::path::Path, operation: &str) -> String {
    database(root).query_row("SELECT revocations_json FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND operation_id=?4",params![scope().owner_id,scope().environment_id,PROFILE,operation],|row|row.get(0)).unwrap()
}

type TargetMap =
    std::collections::BTreeMap<String, std::collections::BTreeSet<(String, String, String)>>;
fn reference_value(reference: &ConnectionRef) -> serde_json::Value {
    serde_json::json!([
        "v4.connection-ref.v1",
        reference.scope.owner_id,
        reference.scope.environment_id,
        reference.profile_id,
        reference.revision,
        reference.credential_id,
        reference.credential_generation
    ])
}
fn reference_for_fixture_a() -> ConnectionRef {
    reference_for(&profile(ProfileKind::ActualRelay))
}
fn coordinator_reference(owner: &Coordinator) -> ConnectionRef {
    reference_for(&owner.profile(PROFILE).unwrap().unwrap())
}
fn expected_targets(targets: &[(ConnectionRef, Vec<LeaseIdentity>)]) -> TargetMap {
    targets
        .iter()
        .map(|(reference, leases)| {
            (
                serde_json::to_string(&reference_value(reference)).unwrap(),
                leases
                    .iter()
                    .map(|lease| {
                        (
                            lease.actor_id.clone(),
                            lease.process_instance_id.clone(),
                            lease.lease_id.clone(),
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}
fn target_map(root: &std::path::Path, operation: &str) -> TargetMap {
    let raw: serde_json::Value = serde_json::from_str(&operation_targets(root, operation)).unwrap();
    let outer = raw.as_array().unwrap();
    assert_eq!(outer.len(), 2);
    assert_eq!(outer[0], "v4.revocation-set.v1");
    let mut result = TargetMap::new();
    for target in outer[1].as_array().unwrap() {
        let pair = target.as_array().unwrap();
        assert_eq!(pair.len(), 2);
        let reference = pair[0].as_array().unwrap();
        assert_eq!(reference.len(), 7);
        assert_eq!(reference[0], "v4.connection-ref.v1");
        let mut leases = std::collections::BTreeSet::new();
        for lease in pair[1].as_array().unwrap() {
            let tuple = lease.as_array().unwrap();
            assert_eq!(tuple.len(), 3);
            assert!(
                leases.insert((
                    tuple[0].as_str().unwrap().into(),
                    tuple[1].as_str().unwrap().into(),
                    tuple[2].as_str().unwrap().into()
                )),
                "duplicate tuple"
            );
        }
        assert!(
            result
                .insert(serde_json::to_string(&pair[0]).unwrap(), leases)
                .is_none(),
            "duplicate reference"
        );
    }
    result
}
fn actor_rows(root: &std::path::Path) -> Vec<Vec<rusqlite::types::Value>> {
    let db = database(root);
    let mut query=db.prepare("SELECT * FROM provider_connection_actors ORDER BY actor_id,process_instance_id,lease_id").unwrap();
    let columns = query.column_count();
    let rows = query
        .query_map([], |row| (0..columns).map(|index| row.get(index)).collect())
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}
fn directory_bytes(root: &std::path::Path) -> std::collections::BTreeMap<String, (u32, Vec<u8>)> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            assert!(metadata.is_file());
            (
                entry.file_name().to_str().unwrap().to_owned(),
                (
                    metadata.permissions().mode(),
                    fs::read(entry.path()).unwrap(),
                ),
            )
        })
        .collect()
}

#[test]
fn fresh_v2_persists_the_complete_immutable_reference_and_live_boot_identity() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    let view = coordinator.lease_view(&handle).unwrap();
    assert_eq!(view.reference, effective.reference);
    assert_eq!(view.status, LeaseStatus::Active);
    assert!(
        !view.identity.actor_id.is_empty()
            && !view.identity.process_instance_id.is_empty()
            && !view.identity.lease_id.is_empty()
    );
    let db = database(root.path());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let raw: String = db
        .query_row(
            "SELECT reference_json FROM provider_connection_actors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        value,
        serde_json::json!([
            "v4.connection-ref.v1",
            scope().owner_id,
            scope().environment_id,
            PROFILE,
            REVISION,
            CREDENTIAL,
            GENERATION
        ])
    );
    assert!(db
        .execute(
            "UPDATE provider_connection_actors SET reference_json='[]'",
            []
        )
        .is_err());
    assert!(db
        .execute("DELETE FROM provider_connection_actors", [])
        .is_err());
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
}

#[test]
fn v1_is_rejected_without_rewriting_database_or_private_key_bytes() {
    let root = private_root();
    let store = FeatureStorage::open(root.path()).unwrap();
    drop(store);
    let before_db = fs::read(root.path().join(DATABASE_FILE)).unwrap();
    let before_key = fs::read(root.path().join(KEY_FILE)).unwrap();
    for suffix in ["-journal", "-wal", "-shm"] {
        let file = root.path().join(format!("{DATABASE_FILE}{suffix}"));
        fs::write(&file, format!("synthetic historical sidecar{suffix}")).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let all_before = directory_bytes(root.path());
    assert_eq!(
        Coordinator::open(
            root.path(),
            TrustedExecutionContext::from_authenticated_execution(scope())
        )
        .err(),
        Some(LeaseError::UnsupportedSchema)
    );
    assert_eq!(directory_bytes(root.path()), all_before);
    assert_eq!(
        fs::read(root.path().join(DATABASE_FILE)).unwrap(),
        before_db
    );
    assert_eq!(fs::read(root.path().join(KEY_FILE)).unwrap(), before_key);
    assert_eq!(u32::from_be_bytes(before_db[60..64].try_into().unwrap()), 1);
}

#[test]
fn changed_scope_reference_credential_endpoint_transport_or_cluster_never_starts_work() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    for field in [
        "owner",
        "environment",
        "profile",
        "kind",
        "auth-mode",
        "auth-binding-id",
        "auth-binding-generation",
        "auth-binding-scope",
        "auth-binding-endpoint",
        "auth-binding-transport",
        "half-id",
        "half-generation",
        "revision",
        "credential",
        "generation",
        "endpoint",
        "transport",
        "cluster",
    ] {
        let mut changed = effective.clone();
        match field {
            "owner" => changed.reference.scope.owner_id = "other-owner".into(),
            "environment" => changed.reference.scope.environment_id = "other-server".into(),
            "profile" => {
                changed.reference.profile_id = "10000000-0000-4000-8000-000000000002".into()
            }
            "kind" => changed.kind = ProfileKind::LmStudioLocal,
            "auth-mode" => changed.auth = StoredAuth::None,
            "auth-binding-id"
            | "auth-binding-generation"
            | "auth-binding-scope"
            | "auth-binding-endpoint"
            | "auth-binding-transport" => {
                let StoredAuth::Bearer(binding) = &mut changed.auth else {
                    panic!("fixture must be bearer");
                };
                match field {
                    "auth-binding-id" => binding.id = NEXT_CREDENTIAL.into(),
                    "auth-binding-generation" => binding.generation = NEXT_GENERATION.into(),
                    "auth-binding-scope" => {
                        binding.target.scope.environment_id = "other-server".into()
                    }
                    "auth-binding-endpoint" => {
                        binding.target.base_url = "https://example.invalid/v1".into()
                    }
                    _ => binding.target.transport = Transport::OpenAiChat,
                }
            }
            "half-id" => changed.reference.credential_id = None,
            "half-generation" => changed.reference.credential_generation = None,
            "revision" => changed.reference.revision = NEXT_REVISION.into(),
            "credential" => changed.reference.credential_id = Some(NEXT_CREDENTIAL.into()),
            "generation" => changed.reference.credential_generation = Some(NEXT_GENERATION.into()),
            "endpoint" => changed.base_url = "https://api.actual.chat/other/v1".into(),
            "transport" => changed.transport = Transport::OpenAiChat,
            _ => changed.cluster_id = Some("different-cluster".into()),
        }
        assert!(
            coordinator
                .admit(REQUEST_A, &changed, ConsumerKind::Cli, action(&counters))
                .is_err(),
            "{field}"
        );
    }
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    assert_eq!(actor_count(root.path()), 0);
}

#[test]
fn pending_deleted_and_revoked_profiles_never_admit_a_later_action() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let _handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    let saved = replace(&mut coordinator);
    assert!(!saved.cleanup_confirmed);
    assert!(coordinator
        .admit(
            REQUEST_B,
            &effective,
            ConsumerKind::StructuredCompact,
            action(&counters)
        )
        .is_err());
    let pending = coordinator.profile(PROFILE).unwrap().unwrap();
    let mut forged_ready = pending.clone();
    forged_ready.activation = Activation::Ready;
    let pending_snapshot =
        runtime::resolve(&scope(), &forged_ready, &reference_for(&forged_ready), None).unwrap();
    assert!(coordinator
        .admit(
            REQUEST_B,
            &pending_snapshot,
            ConsumerKind::DurableTask,
            action(&counters)
        )
        .is_err());
    let mut save = ids();
    save.revision = THIRD_REVISION.into();
    coordinator
        .configure(
            ConfigMutation::Delete(DeleteProfile {
                operation_id: DELETE_OP.into(),
                profile_id: PROFILE.into(),
                expected_revision: NEXT_REVISION.into(),
            }),
            save,
        )
        .unwrap();
    assert!(coordinator
        .admit(
            REQUEST_B,
            &pending_snapshot,
            ConsumerKind::Discovery,
            action(&counters)
        )
        .is_err());
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    assert_eq!(actor_count(root.path()), 1);
}

#[test]
fn every_consumer_kind_registers_a_distinct_per_action_lease() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let mut identities = vec![];
    for (index, consumer) in [
        ConsumerKind::StructuredTurn,
        ConsumerKind::StructuredCompact,
        ConsumerKind::Cli,
        ConsumerKind::DurableTask,
        ConsumerKind::Discovery,
    ]
    .into_iter()
    .enumerate()
    {
        let request = format!("50000000-0000-4000-8000-{:012x}", index + 10);
        let handle = coordinator
            .admit(&request, &effective, consumer, action(&counters))
            .unwrap();
        let view = coordinator.lease_view(&handle).unwrap();
        assert!(!identities.contains(&view.identity.lease_id));
        identities.push(view.identity.lease_id);
    }
    assert_eq!(actor_count(root.path()), 5);
    assert_eq!(counters.starts.load(Ordering::SeqCst), 5);
}

fn race(registration_first: bool) {
    let (root, registering, effective) = relay();
    let mutating = open(root.path());
    let mut registering = Some(registering);
    let mut mutating = Some(mutating);
    let counters = Arc::new(Counters::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let gate = TestGate {
        entered: entered_tx,
        release: release_rx,
    };
    if registration_first {
        registering
            .as_mut()
            .unwrap()
            .pause_once(PausePoint::AdmissionBeforeCommit, gate)
            .unwrap();
        mutating
            .as_mut()
            .unwrap()
            .notify_fence_attempt(attempt_tx)
            .unwrap();
    } else {
        mutating
            .as_mut()
            .unwrap()
            .pause_once(PausePoint::MutationBeforeCapture, gate)
            .unwrap();
        registering
            .as_mut()
            .unwrap()
            .notify_fence_attempt(attempt_tx)
            .unwrap();
    }
    let (first_tx, first_rx) = mpsc::channel();
    let (second_tx, second_rx) = mpsc::channel();
    let (keep_owner, owner_lifetime) = mpsc::channel();
    let first_effective = effective.clone();
    let first_counters = counters.clone();
    let first = if registration_first {
        let mut owner = registering.take().unwrap();
        std::thread::spawn(move || {
            let handle = admit(&mut owner, &first_effective, REQUEST_A, &first_counters);
            let view = owner.lease_view(&handle).unwrap();
            first_tx.send(Some(view)).unwrap();
            let _ = owner_lifetime.recv();
        })
    } else {
        let mut owner = mutating.take().unwrap();
        std::thread::spawn(move || {
            assert!(replace(&mut owner).settings_saved);
            first_tx.send(None).unwrap();
            let _ = owner_lifetime.recv();
        })
    };
    entered_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("first operation holds fence");
    let second_counters = counters.clone();
    let path = root.path().to_path_buf();
    let second = if registration_first {
        let mut contender = mutating.take().unwrap();
        std::thread::spawn(move || {
            let saved = replace(&mut contender);
            second_tx
                .send((saved.cleanup_confirmed, Some(target_map(&path, OPERATION))))
                .unwrap();
        })
    } else {
        let mut contender = registering.take().unwrap();
        std::thread::spawn(move || {
            let admitted = contender
                .admit(
                    REQUEST_A,
                    &effective,
                    ConsumerKind::Cli,
                    action(&second_counters),
                )
                .is_ok();
            second_tx.send((admitted, None)).unwrap();
        })
    };
    attempt_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("contender reached actual fence attempt");
    release_tx.send(()).unwrap();
    let winning_view = first_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let result = second_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    keep_owner.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    assert!(!result.0);
    if registration_first {
        let view = winning_view.unwrap();
        assert_eq!(view.reference, reference_for_fixture_a());
        assert_eq!(
            result.1.unwrap(),
            expected_targets(&[(view.reference.clone(), vec![view.identity])])
        );
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    } else {
        assert!(winning_view.is_none());
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn registration_winning_the_shared_fence_is_captured_by_concurrent_replacement() {
    race(true);
}
#[test]
fn replacement_winning_the_shared_fence_rejects_concurrent_old_registration() {
    race(false);
}

#[test]
fn registration_rollback_and_ambiguous_commit_never_start_or_duplicate_a_resource() {
    for point in [
        FailurePoint::BeforeRegistrationCommit,
        FailurePoint::AfterRegistrationCommitBeforeHandoff,
    ] {
        let (root, mut coordinator, effective) = relay();
        let counters = Arc::new(Counters::default());
        coordinator.fail_once(point).unwrap();
        assert_eq!(
            coordinator
                .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
                .err()
                .map(|failure| failure.error),
            Some(LeaseError::PersistenceFailed)
        );
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
        let count = actor_count(root.path());
        match point {
            FailurePoint::BeforeRegistrationCommit => {
                assert_eq!(count, 0);
                assert!(coordinator.admission_status(REQUEST_A).unwrap().is_none());
            }
            _ => {
                assert_eq!(count, 1);
                let saved = coordinator.admission_status(REQUEST_A).unwrap().unwrap();
                assert_eq!(saved.status, LeaseStatus::RegisteredUnstarted);
                assert_eq!(
                    coordinator
                        .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
                        .err()
                        .map(|failure| failure.error),
                    Some(LeaseError::AdmissionExists)
                );
                assert_eq!(actor_count(root.path()), 1);
            }
        }
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn pending_a_then_delete_b_keeps_a_and_b_targets_and_different_boots_immutable() {
    let (root, mut a, effective_a) = relay();
    let counters = Arc::new(Counters::default());
    let handle_a = admit(&mut a, &effective_a, REQUEST_A, &counters);
    let view_a = a.lease_view(&handle_a).unwrap();
    let mut b = open(root.path());
    let handle_other_boot = admit(&mut b, &effective_a, REQUEST_B, &counters);
    let view_other_boot = b.lease_view(&handle_other_boot).unwrap();
    assert_ne!(
        view_a.identity.process_instance_id,
        view_other_boot.identity.process_instance_id
    );
    let saved = replace(&mut a);
    assert!(!saved.cleanup_confirmed);
    // B remains pending; old boots' unresolved A leases cannot be omitted.
    assert!(b
        .admit(
            "50000000-0000-4000-8000-000000000003",
            &effective_a,
            ConsumerKind::Cli,
            action(&counters)
        )
        .is_err());
    let old_targets = operation_targets(root.path(), OPERATION);
    let reference_b = coordinator_reference(&b);
    let mut save = ids();
    save.revision = THIRD_REVISION.into();
    let deleted = b
        .configure(
            ConfigMutation::Delete(DeleteProfile {
                operation_id: DELETE_OP.into(),
                profile_id: PROFILE.into(),
                expected_revision: NEXT_REVISION.into(),
            }),
            save,
        )
        .unwrap();
    assert!(deleted.settings_saved && !deleted.cleanup_confirmed);
    let targets = operation_targets(root.path(), DELETE_OP);
    let current_b = reference_b;
    assert_eq!(
        target_map(root.path(), DELETE_OP),
        expected_targets(&[
            (
                effective_a.reference.clone(),
                vec![view_a.identity.clone(), view_other_boot.identity.clone()]
            ),
            (current_b, vec![]),
        ])
    );
    assert_eq!(operation_targets(root.path(), OPERATION), old_targets);
    assert!(
        !b.retry_cleanup(PROFILE, DELETE_OP)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 0);
    let proof_a = a.observe_stop(&handle_a).unwrap();
    assert!(
        !a.acknowledge(&handle_a, DELETE_OP, &proof_a)
            .unwrap()
            .cleanup_confirmed
    );
    assert!(
        !b.retry_cleanup(PROFILE, DELETE_OP)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(operation_targets(root.path(), DELETE_OP), targets);
    let proof_b = b.observe_stop(&handle_other_boot).unwrap();
    assert!(
        b.acknowledge(&handle_other_boot, DELETE_OP, &proof_b)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(operation_targets(root.path(), DELETE_OP), targets);
    assert_eq!(operation_targets(root.path(), OPERATION), old_targets);
}

#[test]
fn stop_pending_registry_flags_and_public_ids_cannot_fabricate_quiescence() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    counters.blocked.store(true, Ordering::SeqCst);
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    replace(&mut coordinator);
    assert_eq!(
        coordinator.observe_stop(&handle).err(),
        Some(LeaseError::ResourceStopPending)
    );
    assert!(
        !coordinator
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    // Synthetic adversarial row tampering is not accepted evidence.
    database(root.path())
        .execute(
            "UPDATE provider_connection_actors SET status='quiescent'",
            [],
        )
        .unwrap();
    assert!(
        !coordinator
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 0);
}

fn forged_evidence(handle: &LeaseHandle) -> StopEvidence {
    StopEvidence {
        coordinator_identity: Arc::new(()),
        reference: handle.reference.clone(),
        identity: handle.identity.clone(),
        admission_generation: handle.admission_generation,
        observation_identity: Arc::new(()),
    }
}
#[test]
fn forged_or_wrong_scope_boot_generation_and_unobserved_evidence_cannot_ack() {
    let (_root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    replace(&mut coordinator);
    let original = coordinator.observe_stop(&handle).unwrap();
    for field in [
        "live-identity",
        "owner",
        "environment",
        "profile",
        "revision",
        "credential",
        "credential-generation",
        "actor",
        "boot",
        "lease",
        "generation",
        "observation",
    ] {
        let mut changed = StopEvidence {
            coordinator_identity: original.coordinator_identity.clone(),
            reference: original.reference.clone(),
            identity: original.identity.clone(),
            admission_generation: original.admission_generation,
            observation_identity: original.observation_identity.clone(),
        };
        match field {
            "live-identity" => changed.coordinator_identity = Arc::new(()),
            "owner" => changed.reference.scope.owner_id = "other-owner".into(),
            "environment" => changed.reference.scope.environment_id = "other-server".into(),
            "profile" => {
                changed.reference.profile_id = "10000000-0000-4000-8000-000000000002".into()
            }
            "revision" => changed.reference.revision = NEXT_REVISION.into(),
            "credential" => changed.reference.credential_id = Some(NEXT_CREDENTIAL.into()),
            "credential-generation" => {
                changed.reference.credential_generation = Some(NEXT_GENERATION.into())
            }
            "actor" => changed.identity.actor_id = REQUEST_B.into(),
            "boot" => changed.identity.process_instance_id = REQUEST_B.into(),
            "lease" => changed.identity.lease_id = REQUEST_B.into(),
            "generation" => changed.admission_generation += 1,
            _ => changed.observation_identity = Arc::new(()),
        }
        assert_eq!(
            coordinator.acknowledge(&handle, OPERATION, &changed).err(),
            Some(LeaseError::InvalidEvidence),
            "{field}"
        );
        assert!(
            !coordinator
                .retry_cleanup(PROFILE, OPERATION)
                .unwrap()
                .cleanup_confirmed
        );
    }
    assert_eq!(
        coordinator
            .acknowledge(&handle, OPERATION, &forged_evidence(&handle))
            .err(),
        Some(LeaseError::InvalidEvidence)
    );
    assert!(
        coordinator
            .acknowledge(&handle, OPERATION, &original)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

#[test]
fn observed_join_ack_is_idempotent_but_cannot_ack_an_absent_operation_target() {
    let (_root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    replace(&mut coordinator);
    let evidence = coordinator.observe_stop(&handle).unwrap();
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
    assert_eq!(
        coordinator.acknowledge(&handle, CREATE_OP, &evidence).err(),
        Some(LeaseError::InvalidEvidence)
    );
    let first = coordinator
        .acknowledge(&handle, OPERATION, &evidence)
        .unwrap();
    assert!(first.cleanup_confirmed);
    assert_eq!(
        coordinator
            .acknowledge(&handle, OPERATION, &evidence)
            .unwrap(),
        first
    );
    assert_eq!(
        coordinator.profile(PROFILE).unwrap().unwrap().activation,
        Activation::Ready
    );
}

#[test]
fn restart_rejects_old_live_handles_and_never_treats_old_boot_as_stopped() {
    let (root, mut old, effective) = relay();
    let counters = Arc::new(Counters::default());
    let old_handle = admit(&mut old, &effective, REQUEST_A, &counters);
    replace(&mut old);
    let mut restarted = open(root.path());
    assert_eq!(
        restarted.observe_stop(&old_handle).err(),
        Some(LeaseError::StaleHandle)
    );
    assert!(
        !restarted
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 0);
}

#[test]
fn ack_sql_abort_keeps_old_row_and_receipt_then_exact_evidence_retry_succeeds() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    let saved = replace(&mut coordinator);
    let evidence = coordinator.observe_stop(&handle).unwrap();
    let before_actor = actor_rows(root.path());
    coordinator.fail_once(FailurePoint::AfterAckWrite).unwrap();
    assert_eq!(
        coordinator.acknowledge(&handle, OPERATION, &evidence).err(),
        Some(LeaseError::PersistenceFailed)
    );
    assert_eq!(actor_rows(root.path()), before_actor);
    assert!(
        !coordinator
            .operation_status(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(
        coordinator.profile(PROFILE).unwrap().unwrap().activation,
        Activation::CleanupPending
    );
    assert_eq!(
        database(root.path())
            .query_row(
                "SELECT COUNT(*) FROM provider_connection_actors WHERE status='quiescent'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let retried = coordinator
        .acknowledge(&handle, OPERATION, &evidence)
        .unwrap();
    assert!(retried.cleanup_confirmed);
    assert_eq!(retried.saved_revision, saved.saved_revision);
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

#[test]
fn normal_observed_completion_consumes_a_lease_without_reusing_its_authority() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    let view = coordinator.lease_view(&handle).unwrap();
    let evidence = coordinator.observe_stop(&handle).unwrap();
    coordinator.release_completed(&handle, &evidence).unwrap();
    assert_completed_row_has_authenticated_prior_fact(root.path(), &handle);
    let next = admit(&mut coordinator, &effective, REQUEST_B, &counters);
    let next_view = coordinator.lease_view(&next).unwrap();
    assert_ne!(view.identity.lease_id, next_view.identity.lease_id);
    assert_eq!(actor_count(root.path()), 2);
    assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
    assert!(!replace(&mut coordinator).cleanup_confirmed);
    assert_eq!(
        target_map(root.path(), OPERATION),
        expected_targets(&[(effective.reference.clone(), vec![next_view.identity])])
    );
    assert_eq!(
        coordinator.lease_view(&handle).unwrap().status,
        LeaseStatus::Quiescent
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

struct ChildStart(Arc<AtomicBool>);
struct ChildRunning {
    child: std::process::Child,
    exited: Arc<AtomicBool>,
}
impl StartOwnedResource for ChildStart {
    fn start(self: Box<Self>) -> StartOutcome {
        use std::process::{Command, Stdio};
        // Synchronous ownership transfer only; no readiness handshake under fence.
        match Command::new("/bin/sh")
            .args(["-c", "read -r owned_input"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
        {
            Ok(child) => StartOutcome::Started(Box::new(ChildRunning {
                child,
                exited: self.0,
            })),
            // spawn reported no owned child; no potentially running child is substituted.
            Err(_) => StartOutcome::FailedOwned {
                error: LeaseError::PersistenceFailed,
                owner: Box::new(FakeRunning(Arc::new(Counters::default()))),
            },
        }
    }
}
impl OwnedRunningResource for ChildRunning {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        self.child.stdin.take();
        self.child
            .wait()
            .map_err(|_| LeaseError::ResourceStopPending)?;
        self.exited.store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for ChildRunning {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[test]
fn owned_synthetic_child_exit_is_observed_before_cleanup_confirmation() {
    let (_root, mut coordinator, effective) = relay();
    let exited = Arc::new(AtomicBool::new(false));
    let handle = coordinator
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Cli,
            Box::new(ChildStart(exited.clone())),
        )
        .unwrap();
    replace(&mut coordinator);
    assert!(!exited.load(Ordering::SeqCst));
    assert!(
        !coordinator
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    let evidence = coordinator.observe_stop(&handle).unwrap();
    assert!(exited.load(Ordering::SeqCst));
    assert!(
        coordinator
            .acknowledge(&handle, OPERATION, &evidence)
            .unwrap()
            .cleanup_confirmed
    );
}

#[test]
fn accepted_old_ack_cannot_close_a_new_revision_lease_or_rewrite_its_delete_targets() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let old = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    replace(&mut coordinator);
    let evidence = coordinator.observe_stop(&old).unwrap();
    coordinator.acknowledge(&old, OPERATION, &evidence).unwrap();
    let current = snapshot(&coordinator);
    let new = admit(&mut coordinator, &current, REQUEST_B, &counters);
    let new_view = coordinator.lease_view(&new).unwrap();
    let mut save = ids();
    save.revision = THIRD_REVISION.into();
    let deleted = coordinator
        .configure(
            ConfigMutation::Delete(DeleteProfile {
                operation_id: DELETE_OP.into(),
                profile_id: PROFILE.into(),
                expected_revision: NEXT_REVISION.into(),
            }),
            save,
        )
        .unwrap();
    assert!(!deleted.cleanup_confirmed);
    let targets = operation_targets(root.path(), DELETE_OP);
    assert_eq!(
        coordinator.acknowledge(&old, DELETE_OP, &evidence).err(),
        Some(LeaseError::InvalidEvidence)
    );
    assert_eq!(
        coordinator.lease_view(&new).unwrap().identity,
        new_view.identity
    );
    assert_eq!(
        coordinator.lease_view(&new).unwrap().status,
        LeaseStatus::Revoked
    );
    assert_eq!(operation_targets(root.path(), DELETE_OP), targets);
    assert!(
        !coordinator
            .retry_cleanup(PROFILE, DELETE_OP)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

#[test]
fn ack_activation_abort_rolls_back_evidence_and_flag_without_resealing_credentials() {
    let (root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut coordinator, &effective, REQUEST_A, &counters);
    replace(&mut coordinator);
    let evidence = coordinator.observe_stop(&handle).unwrap();
    let db = database(root.path());
    let ciphertext: String = db
        .query_row(
            "SELECT ciphertext FROM provider_connection_credentials",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let before_actor = actor_rows(root.path());
    db.execute_batch("CREATE TRIGGER provider_connection_test_abort_activation BEFORE UPDATE OF record_json ON provider_connection_profiles BEGIN SELECT RAISE(ABORT,'synthetic lease activation failure'); END;").unwrap();
    assert_eq!(
        coordinator.acknowledge(&handle, OPERATION, &evidence).err(),
        Some(LeaseError::PersistenceFailed)
    );
    assert_eq!(actor_rows(root.path()), before_actor);
    assert_eq!(
        db.query_row(
            "SELECT cleanup_confirmed FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM provider_connection_actors WHERE status='quiescent'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        coordinator.profile(PROFILE).unwrap().unwrap().activation,
        Activation::CleanupPending
    );
    db.execute_batch("DROP TRIGGER provider_connection_test_abort_activation")
        .unwrap();
    assert!(
        coordinator
            .acknowledge(&handle, OPERATION, &evidence)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(
        db.query_row(
            "SELECT ciphertext FROM provider_connection_credentials",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        ciphertext
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

struct FenceProbeStart {
    root: std::path::PathBuf,
    fence_held: Arc<AtomicBool>,
}
impl StartOwnedResource for FenceProbeStart {
    fn start(self: Box<Self>) -> StartOutcome {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let attempt = (|| -> LeaseResult<()> {
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open(self.root.join(ADMISSION_LOCK_FILE))
                .map_err(|_| LeaseError::PersistenceFailed)?;
            let acquired =
                unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
            let blocked = !acquired
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK);
            if acquired {
                unsafe {
                    libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
                }
            }
            self.fence_held.store(blocked, Ordering::SeqCst);
            Ok(())
        })();
        let owner = Box::new(FakeRunning(Arc::new(Counters::default())));
        match attempt {
            Ok(()) => StartOutcome::Started(owner),
            Err(error) => StartOutcome::FailedOwned { error, owner },
        }
    }
}

#[test]
fn shared_os_fence_is_still_held_through_the_owned_resource_start_handoff() {
    let (root, mut coordinator, effective) = relay();
    let fence_held = Arc::new(AtomicBool::new(false));
    let handle = coordinator
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Discovery,
            Box::new(FenceProbeStart {
                root: root.path().to_path_buf(),
                fence_held: fence_held.clone(),
            }),
        )
        .unwrap();
    assert!(
        fence_held.load(Ordering::SeqCst),
        "registration commit must not release the shared fence before start ownership transfers"
    );
    assert_eq!(
        coordinator.lease_view(&handle).unwrap().status,
        LeaseStatus::Active
    );
}

#[test]
fn committed_unstarted_identity_remains_required_through_replace_and_delete() {
    let (root, mut owner, effective) = relay();
    let counters = Arc::new(Counters::default());
    owner
        .fail_once(FailurePoint::AfterRegistrationCommitBeforeHandoff)
        .unwrap();
    let failure = owner
        .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
        .err()
        .unwrap();
    assert_eq!(failure.error, LeaseError::PersistenceFailed);
    let unstarted = owner.admission_status(REQUEST_A).unwrap().unwrap();
    assert_eq!(unstarted.status, LeaseStatus::RegisteredUnstarted);
    assert_eq!(unstarted.reference, effective.reference);
    let saved = replace(&mut owner);
    assert!(!saved.cleanup_confirmed);
    let original_targets = operation_targets(root.path(), OPERATION);
    assert_eq!(
        target_map(root.path(), OPERATION),
        expected_targets(&[(
            effective.reference.clone(),
            vec![unstarted.identity.clone()]
        )])
    );
    let reference_b = coordinator_reference(&owner);
    let mut save = ids();
    save.revision = THIRD_REVISION.into();
    let deleted = owner
        .configure(
            ConfigMutation::Delete(DeleteProfile {
                operation_id: DELETE_OP.into(),
                profile_id: PROFILE.into(),
                expected_revision: NEXT_REVISION.into(),
            }),
            save,
        )
        .unwrap();
    assert!(deleted.settings_saved && !deleted.cleanup_confirmed);
    assert_eq!(
        target_map(root.path(), DELETE_OP),
        expected_targets(&[
            (effective.reference, vec![unstarted.identity]),
            (reference_b, vec![])
        ])
    );
    assert_eq!(operation_targets(root.path(), OPERATION), original_targets);
    let mut other_boot = open(root.path());
    assert!(
        !other_boot
            .retry_cleanup(PROFILE, DELETE_OP)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 0);
}

#[test]
fn postcommit_prestart_barrier_keeps_the_contender_out_until_ownership_handoff() {
    let (root, mut admitting, effective) = relay();
    let mut mutating = open(root.path());
    let counters = Arc::new(Counters::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    admitting
        .pause_once(
            PausePoint::HandoffMarkedBeforeStart,
            TestGate {
                entered: entered_tx,
                release: release_rx,
            },
        )
        .unwrap();
    mutating.notify_fence_attempt(attempt_tx).unwrap();
    let action_counters = counters.clone();
    let path = root.path().to_path_buf();
    let (first_tx, first_rx) = mpsc::channel();
    let (keep_owner, owner_lifetime) = mpsc::channel();
    let first = std::thread::spawn(move || {
        let handle = admit(&mut admitting, &effective, REQUEST_A, &action_counters);
        first_tx
            .send(admitting.lease_view(&handle).unwrap())
            .unwrap();
        let _ = owner_lifetime.recv();
    });
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        database(root.path())
            .query_row("SELECT status FROM provider_connection_actors", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "handoff_uncertain"
    );
    let (second_tx, second_rx) = mpsc::channel();
    let second = std::thread::spawn(move || {
        let saved = replace(&mut mutating);
        second_tx
            .send((saved, target_map(&path, OPERATION)))
            .unwrap();
    });
    attempt_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("real contender attempted same held fence");
    let before_handoff = second_rx.try_recv();
    release_tx.send(()).unwrap();
    let view = first_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (saved, targets) = second_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    keep_owner.send(()).unwrap();
    first.join().unwrap();
    second.join().unwrap();
    assert!(
        matches!(before_handoff, Err(mpsc::TryRecvError::Empty)),
        "mutation cannot cross committed registration/start gap"
    );
    assert!(!saved.cleanup_confirmed);
    assert_eq!(
        targets,
        expected_targets(&[(view.reference, vec![view.identity])])
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
}

#[test]
fn fresh_v2_header_is_published_and_second_live_open_preserves_key_profile_and_receipts_in_wal() {
    let (root, first, effective) = relay();
    let key = fs::read(root.path().join(KEY_FILE)).unwrap();
    let profile = first.profile(PROFILE).unwrap();
    let receipt = first.operation_status(PROFILE, CREATE_OP).unwrap();
    let header = fs::read(root.path().join(DATABASE_FILE)).unwrap();
    assert_eq!(u32::from_be_bytes(header[60..64].try_into().unwrap()), 2);
    let db = database(root.path());
    assert_eq!(
        db.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    db.execute(
        "UPDATE provider_connection_profiles SET record_json=record_json",
        [],
    )
    .unwrap();
    assert!(root.path().join(format!("{DATABASE_FILE}-wal")).exists());
    let second = open(root.path());
    assert_eq!(second.profile(PROFILE).unwrap(), profile);
    assert_eq!(
        second.operation_status(PROFILE, CREATE_OP).unwrap(),
        receipt
    );
    assert_eq!(snapshot(&second), effective);
    assert_eq!(fs::read(root.path().join(KEY_FILE)).unwrap(), key);
    assert_eq!(first.profile(PROFILE).unwrap(), profile);
    assert_eq!(first.operation_status(PROFILE, CREATE_OP).unwrap(), receipt);
}

#[test]
fn copied_valid_accepted_fact_and_public_tuple_cannot_cover_another_live_lease() {
    let (root, mut owner, effective) = relay();
    let counters = Arc::new(Counters::default());
    let first = admit(&mut owner, &effective, REQUEST_A, &counters);
    let second = admit(&mut owner, &effective, REQUEST_B, &counters);
    let first_view = owner.lease_view(&first).unwrap();
    let second_view = owner.lease_view(&second).unwrap();
    replace(&mut owner);
    let proof = owner.observe_stop(&first).unwrap();
    assert!(
        !owner
            .acknowledge(&first, OPERATION, &proof)
            .unwrap()
            .cleanup_confirmed
    );
    let db = database(root.path());
    let prior: String = db
        .query_row(
            "SELECT stop_evidence_json FROM provider_connection_actors WHERE lease_id=?1",
            [first_view.identity.lease_id],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("UPDATE provider_connection_actors SET status='quiescent',stop_evidence_json=?1 WHERE lease_id=?2",params![prior,second_view.identity.lease_id]).unwrap();
    assert!(
        !owner
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    let mut other_boot = open(root.path());
    assert_eq!(
        other_boot.observe_stop(&second).err(),
        Some(LeaseError::StaleHandle)
    );
    assert!(
        !other_boot
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

struct PartialWorkerStart {
    starts: Arc<AtomicUsize>,
    fail_join_once: Arc<AtomicBool>,
    failed_outcome: bool,
    running: Arc<AtomicBool>,
    joined: Arc<AtomicBool>,
    stop_seen: mpsc::Sender<()>,
    exit_gate: mpsc::Receiver<()>,
}
struct PartialWorkerOwner {
    worker: Option<std::thread::JoinHandle<()>>,
    stop: Option<mpsc::Sender<()>>,
    joined: Arc<AtomicBool>,
    fail_join_once: Arc<AtomicBool>,
}
impl StartOwnedResource for PartialWorkerStart {
    fn start(self: Box<Self>) -> StartOutcome {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (stop, stop_rx) = mpsc::channel();
        let (ready, ready_rx) = mpsc::channel();
        let running = self.running;
        let seen = self.stop_seen;
        let exit = self.exit_gate;
        let worker = std::thread::spawn(move || {
            running.store(true, Ordering::SeqCst);
            ready.send(()).unwrap();
            let _ = stop_rx.recv();
            let _ = seen.send(());
            let _ = exit.recv();
            running.store(false, Ordering::SeqCst);
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let owner = Box::new(PartialWorkerOwner {
            worker: Some(worker),
            stop: Some(stop),
            joined: self.joined,
            fail_join_once: self.fail_join_once,
        });
        if self.failed_outcome {
            StartOutcome::FailedOwned {
                error: LeaseError::HandoffFailed,
                owner,
            }
        } else {
            StartOutcome::Started(owner)
        }
    }
}
impl OwnedRunningResource for PartialWorkerOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        if self.fail_join_once.swap(false, Ordering::SeqCst) {
            return Err(LeaseError::ResourceStopPending);
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| LeaseError::ResourceStopPending)?;
        }
        self.joined.store(true, Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for PartialWorkerOwner {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        } /* test owns exit gate; do not claim joined on Drop */
    }
}

#[test]
fn partially_started_failed_owner_stays_pending_until_actual_worker_join_then_ack() {
    let (root, mut owner, effective) = relay();
    let running = Arc::new(AtomicBool::new(false));
    let joined = Arc::new(AtomicBool::new(false));
    let (seen, seen_rx) = mpsc::channel();
    let (exit, exit_rx) = mpsc::channel();
    let failure = owner
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Cli,
            Box::new(PartialWorkerStart {
                starts: Arc::new(AtomicUsize::new(0)),
                fail_join_once: Arc::new(AtomicBool::new(false)),
                failed_outcome: true,
                running: running.clone(),
                joined: joined.clone(),
                stop_seen: seen,
                exit_gate: exit_rx,
            }),
        )
        .err()
        .unwrap();
    assert_eq!(failure.error, LeaseError::HandoffFailed);
    let handle = failure
        .owned_handle
        .expect("begun failed handoff retains private authority");
    assert_eq!(
        owner.lease_view(&handle).unwrap().status,
        LeaseStatus::HandoffUncertain
    );
    assert!(running.load(Ordering::SeqCst));
    assert!(!replace(&mut owner).cleanup_confirmed);
    let immutable = operation_targets(root.path(), OPERATION);
    assert!(
        !owner
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    let (done, done_rx) = mpsc::channel();
    let observer = std::thread::spawn(move || {
        let proof = owner.observe_stop(&handle).unwrap();
        assert!(done.send((owner, handle, proof)).is_ok());
    });
    seen_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let before_join = done_rx.try_recv();
    let mut other = open(root.path());
    assert!(
        !other
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert!(!joined.load(Ordering::SeqCst));
    exit.send(()).unwrap();
    let (mut owner, handle, proof) = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    observer.join().unwrap();
    assert!(matches!(before_join, Err(mpsc::TryRecvError::Empty)));
    assert!(joined.load(Ordering::SeqCst));
    assert!(!running.load(Ordering::SeqCst));
    assert!(
        owner
            .acknowledge(&handle, OPERATION, &proof)
            .unwrap()
            .cleanup_confirmed
    );
    assert_eq!(operation_targets(root.path(), OPERATION), immutable);
}

#[test]
fn accepted_durable_stop_fact_requires_its_original_private_feature_key_after_restart() {
    let (root, mut owner, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut owner, &effective, REQUEST_A, &counters);
    replace(&mut owner);
    let proof = owner.observe_stop(&handle).unwrap();
    assert!(
        owner
            .acknowledge(&handle, OPERATION, &proof)
            .unwrap()
            .cleanup_confirmed
    );
    drop(owner);
    fs::remove_file(root.path().join(KEY_FILE)).unwrap();
    let bytes = directory_bytes(root.path());
    assert_eq!(
        Coordinator::open(
            root.path(),
            TrustedExecutionContext::from_authenticated_execution(scope())
        )
        .err(),
        Some(LeaseError::KeyUnavailable)
    );
    assert!(!root.path().join(KEY_FILE).exists());
    assert_eq!(directory_bytes(root.path()), bytes);
}

fn postcallback_write_failure_retains_original_owner(failed_outcome: bool) {
    let (root, mut owner, effective) = relay();
    let running = Arc::new(AtomicBool::new(false));
    let joined = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicUsize::new(0));
    let (seen, _seen_rx) = mpsc::channel();
    let (exit, exit_rx) = mpsc::channel();
    owner
        .fail_once(FailurePoint::AfterReturnedOwnerBeforeStatusCommit)
        .unwrap();
    let failure = owner
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Cli,
            Box::new(PartialWorkerStart {
                starts: starts.clone(),
                fail_join_once: Arc::new(AtomicBool::new(true)),
                failed_outcome,
                running: running.clone(),
                joined: joined.clone(),
                stop_seen: seen,
                exit_gate: exit_rx,
            }),
        )
        .err()
        .unwrap();
    assert_eq!(failure.error, LeaseError::PersistenceFailed);
    let handle = failure
        .owned_handle
        .expect("postcallback SQL failure retains original live authority");
    let original = owner.lease_view(&handle).unwrap();
    assert_eq!(original.status, LeaseStatus::HandoffUncertain);
    assert_eq!(original.reference, effective.reference);
    assert_eq!(
        owner.admission_status(REQUEST_A).unwrap().unwrap().identity,
        original.identity
    );
    assert!(running.load(Ordering::SeqCst));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let counter = Arc::new(Counters::default());
    assert_eq!(
        owner
            .admit(
                REQUEST_A,
                &effective,
                ConsumerKind::StructuredCompact,
                action(&counter)
            )
            .err()
            .map(|error| error.error),
        Some(LeaseError::AdmissionExists)
    );
    assert!(!replace(&mut owner).cleanup_confirmed);
    assert_eq!(
        target_map(root.path(), OPERATION),
        expected_targets(&[(original.reference.clone(), vec![original.identity.clone()])])
    );
    let immutable = operation_targets(root.path(), OPERATION);
    assert!(owner
        .admit(REQUEST_B, &effective, ConsumerKind::Cli, action(&counter))
        .is_err());
    assert_eq!(counter.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        owner.observe_stop(&handle).err(),
        Some(LeaseError::ResourceStopPending)
    );
    assert!(running.load(Ordering::SeqCst));
    assert!(!joined.load(Ordering::SeqCst));
    assert!(
        !owner
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    exit.send(()).unwrap();
    let proof = owner.observe_stop(&handle).unwrap();
    assert!(joined.load(Ordering::SeqCst));
    assert!(!running.load(Ordering::SeqCst));
    let receipt = owner.acknowledge(&handle, OPERATION, &proof).unwrap();
    assert!(receipt.cleanup_confirmed);
    assert_eq!(
        owner.acknowledge(&handle, OPERATION, &proof).unwrap(),
        receipt
    );
    assert_eq!(operation_targets(root.path(), OPERATION), immutable);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}
#[test]
fn started_owner_survives_postcallback_write_failure_and_retry_joins_original() {
    postcallback_write_failure_retains_original_owner(false);
}
#[test]
fn failed_owned_owner_survives_postcallback_write_failure_and_retry_joins_original() {
    postcallback_write_failure_retains_original_owner(true);
}

#[test]
fn dropped_failed_handle_and_new_boot_never_restore_authority_or_confirm_cleanup() {
    let (root, mut owner, effective) = relay();
    let running = Arc::new(AtomicBool::new(false));
    let joined = Arc::new(AtomicBool::new(false));
    let (seen, _seen_rx) = mpsc::channel();
    let (exit, exit_rx) = mpsc::channel();
    let failure = owner
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Cli,
            Box::new(PartialWorkerStart {
                starts: Arc::new(AtomicUsize::new(0)),
                fail_join_once: Arc::new(AtomicBool::new(false)),
                failed_outcome: true,
                running: running.clone(),
                joined: joined.clone(),
                stop_seen: seen,
                exit_gate: exit_rx,
            }),
        )
        .err()
        .unwrap();
    assert!(failure.owned_handle.is_some());
    let public = owner.admission_status(REQUEST_A).unwrap().unwrap();
    drop(failure);
    assert!(running.load(Ordering::SeqCst));
    assert!(!joined.load(Ordering::SeqCst));
    assert!(!replace(&mut owner).cleanup_confirmed);
    let mut other = open(root.path());
    let forged = LeaseHandle {
        coordinator_identity: Arc::new(()),
        reference: public.reference,
        identity: public.identity,
        admission_generation: 1,
    };
    assert_eq!(
        other.observe_stop(&forged).err(),
        Some(LeaseError::StaleHandle)
    );
    assert!(
        !other
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
    assert!(running.load(Ordering::SeqCst));
    assert!(!joined.load(Ordering::SeqCst));
    // Owned test cleanup releases its exit gate. Coordinator still owns cancellation;
    // dropping it cannot produce accepted evidence or a successful receipt.
    exit.send(()).unwrap();
    drop(owner);
    assert!(
        !other
            .retry_cleanup(PROFILE, OPERATION)
            .unwrap()
            .cleanup_confirmed
    );
}

fn assert_completed_row_has_authenticated_prior_fact(root: &std::path::Path, handle: &LeaseHandle) {
    let(status,prior):(String,String)=database(root).query_row(
        "SELECT status,stop_evidence_json FROM provider_connection_actors WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND actor_id=?4 AND process_instance_id=?5 AND lease_id=?6",
        params![handle.reference.scope.owner_id,handle.reference.scope.environment_id,handle.reference.profile_id,handle.identity.actor_id,handle.identity.process_instance_id,handle.identity.lease_id],
        |row|Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    assert_eq!(status, "quiescent");
    // Synthetic fixture key only. This test issues no application-facing key export.
    let key = zeroize::Zeroizing::new(fs::read_to_string(root.join(KEY_FILE)).unwrap());
    let mut master = zeroize::Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(
        key.strip_prefix(crate::storage::KEY_PREFIX).unwrap(),
        &mut *master,
    )
    .unwrap();
    let verifier = stop_fact::StopFactMac::from_private_feature_key(Some(&*master)).unwrap();
    assert!(verifier
        .verify_prior(
            &prior,
            &handle.reference,
            &handle.identity,
            handle.admission_generation
        )
        .is_ok());
}
fn operation_rows(root: &std::path::Path) -> Vec<Vec<rusqlite::types::Value>> {
    let db = database(root);
    let mut query = db
        .prepare("SELECT * FROM provider_connection_operations ORDER BY operation_id")
        .unwrap();
    let count = query.column_count();
    let rows = query
        .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}
#[test]
fn normal_completion_persistence_failure_preserves_private_capabilities_for_exact_retry() {
    let (root, mut owner, effective) = relay();
    let counters = Arc::new(Counters::default());
    let handle = admit(&mut owner, &effective, REQUEST_A, &counters);
    let proof = owner.observe_stop(&handle).unwrap();
    let before_actor = actor_rows(root.path());
    let before_ops = operation_rows(root.path());
    let before_receipt = owner.operation_status(PROFILE, CREATE_OP).unwrap();
    let before_profile = owner.profile(PROFILE).unwrap();
    let before_ciphertext: String = database(root.path())
        .query_row(
            "SELECT ciphertext FROM provider_connection_credentials",
            [],
            |row| row.get(0),
        )
        .unwrap();
    owner
        .fail_once(FailurePoint::AfterCompletedFactWrite)
        .unwrap();
    assert_eq!(
        owner.release_completed(&handle, &proof).err(),
        Some(LeaseError::PersistenceFailed)
    );
    assert_eq!(actor_rows(root.path()), before_actor);
    assert_eq!(operation_rows(root.path()), before_ops);
    assert_eq!(
        owner.operation_status(PROFILE, CREATE_OP).unwrap(),
        before_receipt
    );
    assert_eq!(owner.profile(PROFILE).unwrap(), before_profile);
    assert_eq!(
        database(root.path())
            .query_row(
                "SELECT ciphertext FROM provider_connection_credentials",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        before_ciphertext
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
    // The same borrowed private capabilities remain usable after the failed commit.
    owner.release_completed(&handle, &proof).unwrap();
    assert_completed_row_has_authenticated_prior_fact(root.path(), &handle);
    let accepted_actor = actor_rows(root.path());
    let accepted_ops = operation_rows(root.path());
    owner.release_completed(&handle, &proof).unwrap();
    assert_eq!(actor_rows(root.path()), accepted_actor);
    assert_eq!(owner.profile(PROFILE).unwrap(), before_profile);
    assert_eq!(
        database(root.path())
            .query_row(
                "SELECT ciphertext FROM provider_connection_credentials",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        before_ciphertext
    );
    assert_eq!(operation_rows(root.path()), accepted_ops);
    assert_eq!(
        owner.observe_stop(&handle).err(),
        Some(LeaseError::StaleHandle)
    );
    assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    assert_eq!(counters.joins.load(Ordering::SeqCst), 1);
}

fn exact_schema_objects(db: &rusqlite::Connection) -> Vec<(String, String, Option<String>)> {
    let mut query=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").unwrap();
    let rows = query
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn retained_v2_actor_corruption_is_rejected_without_dispatch_confirmation_activation_or_repair() {
    for field in [
        "reference-index-revision",
        "reference-index-generation",
        "half-id",
        "half-generation",
        "admission-zero",
        "unknown-consumer",
    ] {
        let (root, mut owner, effective) = relay();
        let counters = Arc::new(Counters::default());
        let _handle = admit(&mut owner, &effective, REQUEST_A, &counters);
        let db = database(root.path());
        let objects = exact_schema_objects(&db);
        let trigger: String = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='immutable_actor_binding'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        db.execute_batch("BEGIN IMMEDIATE; DROP TRIGGER immutable_actor_binding;")
            .unwrap();
        let mut reference = reference_value(&effective.reference);
        match field {
            "reference-index-revision" => {
                reference[4] = serde_json::json!(NEXT_REVISION);
                db.execute(
                    "UPDATE provider_connection_actors SET reference_json=?1",
                    [reference.to_string()],
                )
                .unwrap();
            }
            "reference-index-generation" => {
                db.execute(
                    "UPDATE provider_connection_actors SET credential_generation=?1",
                    [NEXT_GENERATION],
                )
                .unwrap();
            }
            "half-id" => {
                reference[5] = serde_json::Value::Null;
                db.execute(
                    "UPDATE provider_connection_actors SET reference_json=?1",
                    [reference.to_string()],
                )
                .unwrap();
            }
            "half-generation" => {
                reference[6] = serde_json::Value::Null;
                db.execute("UPDATE provider_connection_actors SET reference_json=?1,credential_generation=NULL",[reference.to_string()]).unwrap();
            }
            "admission-zero" => {
                db.execute(
                    "UPDATE provider_connection_actors SET admission_generation=0",
                    [],
                )
                .unwrap();
            }
            _ => {
                db.execute(
                    "UPDATE provider_connection_actors SET consumer_kind='public-unknown-consumer'",
                    [],
                )
                .unwrap();
            }
        }
        db.execute_batch(&trigger).unwrap();
        db.execute_batch("COMMIT").unwrap();
        assert_eq!(
            exact_schema_objects(&db),
            objects,
            "fixture restores exact schemaobjects before reading"
        );
        let corrupt_actor = actor_rows(root.path());
        let old_ops = operation_rows(root.path());
        let old_profile = owner.profile(PROFILE).unwrap();
        let ciphertext: String = db
            .query_row(
                "SELECT ciphertext FROM provider_connection_credentials",
                [],
                |row| row.get(0),
            )
            .unwrap();
        match Coordinator::open(
            root.path(),
            TrustedExecutionContext::from_authenticated_execution(scope()),
        ) {
            Err(error) => assert_eq!(error, LeaseError::PersistenceFailed, "{field}"),
            Ok(mut reopened) => assert_eq!(
                reopened.configure(replacement(), ids()).err(),
                Some(LeaseError::PersistenceFailed),
                "{field}:firstcapturemuststrictlyvalidateretainedactor"
            ),
        }
        assert_eq!(
            actor_rows(root.path()),
            corrupt_actor,
            "{field}:neverrepairidentity"
        );
        assert_eq!(
            operation_rows(root.path()),
            old_ops,
            "{field}:no saved/confirmed operation"
        );
        assert_eq!(
            owner.profile(PROFILE).unwrap(),
            old_profile,
            "{field}:noactivationorrevisionchange"
        );
        assert_eq!(
            db.query_row(
                "SELECT ciphertext FROM provider_connection_credentials",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            ciphertext
        );
        assert_eq!(exact_schema_objects(&db), objects);
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
        assert_eq!(counters.joins.load(Ordering::SeqCst), 0);
    }
}

// UNAPPLIED append INSIDE existing leases::tests, with its actual relay()/action()
// counters/actor_count fixtures available. No new fake resource or stop evidence.
struct EnteredPanicStart(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl StartOwnedResource for EnteredPanicStart {
    fn start(self: Box<Self>) -> StartOutcome {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // No thread spawned: callback entry alone forbids a no-start origin.
        panic!("synthetic callback entered then failed before returning an owner");
    }
}
// V2 ND-PREVIEW-003: count calls on the original returned owner while keeping
// the existing actual PartialWorkerStart thread/owner, not a no-op replacement.
struct ExtractedJoinCounterStart {
    original: Box<dyn StartOwnedResource>,
    calls: Arc<AtomicUsize>,
}
struct ExtractedJoinCounterOwner {
    original: Box<dyn OwnedRunningResource>,
    calls: Arc<AtomicUsize>,
}
impl StartOwnedResource for ExtractedJoinCounterStart {
    fn start(self: Box<Self>) -> StartOutcome {
        let calls = self.calls;
        match self.original.start() {
            StartOutcome::Started(original) => {
                StartOutcome::Started(Box::new(ExtractedJoinCounterOwner { original, calls }))
            }
            StartOutcome::FailedOwned {
                error,
                owner: original,
            } => StartOutcome::FailedOwned {
                error,
                owner: Box::new(ExtractedJoinCounterOwner { original, calls }),
            },
        }
    }
}
impl OwnedRunningResource for ExtractedJoinCounterOwner {
    fn cancel_and_join(&mut self) -> LeaseResult<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.original.cancel_and_join()
    }
}
#[test]
fn entered_or_reserved_original_admissions_never_become_no_handle_no_start_proofs() {
    // Original lexical pre-callback origin, not a starts0/SQL-row inference.
    let (_root, mut coordinator, effective) = relay();
    let counters = Arc::new(Counters::default());
    coordinator
        .fail_once(FailurePoint::BeforeRegistrationCommit)
        .unwrap();
    let failure = coordinator
        .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
        .err()
        .unwrap();
    let (error, disposition) = failure.into_disposition();
    assert_eq!(error, LeaseError::PersistenceFailed);
    let original = match disposition {
        AdmissionDisposition::NeverDispatched(original) => original,
        _ => panic!("original validated pre-callback failure must retain its sealed origin"),
    };
    coordinator
        .verify_never_dispatched(&original, REQUEST_A, &effective, ConsumerKind::Cli)
        .unwrap();
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);

    // Legacy consuming view remains lossy: no positive proof comes from None.
    coordinator
        .fail_once(FailurePoint::BeforeRegistrationCommit)
        .unwrap();
    let legacy = coordinator
        .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
        .err()
        .unwrap();
    let (error, handle) = legacy.into_parts();
    assert_eq!(error, LeaseError::PersistenceFailed);
    assert!(handle.is_none());
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);

    // Registration committed and reservation retained: Some stays Owned despite
    // starts0. The no-handle gate never converts it to no-op/StopEvidence.
    let (root, mut reserved, effective) = relay();
    let counters = Arc::new(Counters::default());
    reserved
        .fail_once(FailurePoint::AfterRegistrationCommitBeforeHandoff)
        .unwrap();
    let (_, disposition) = reserved
        .admit(REQUEST_A, &effective, ConsumerKind::Cli, action(&counters))
        .err()
        .unwrap()
        .into_disposition();
    let handle = match disposition {
        AdmissionDisposition::Owned(handle) => handle,
        _ => panic!("Some original handle must be preserved"),
    };
    assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        reserved.observe_stop(&handle).err(),
        Some(LeaseError::ResourceStopPending)
    );
    assert_eq!(actor_count(root.path()), 1);
    assert_eq!(
        reserved.lease_view(&handle).unwrap().status,
        LeaseStatus::RegisteredUnstarted
    );

    // Consumed BeforeCallback cannot return after panic. Existing original handle
    // stays unknown and cannot be replaced by a never-dispatched token or owner.
    let (root, mut entered, effective) = relay();
    let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let failure = entered
        .admit(
            REQUEST_A,
            &effective,
            ConsumerKind::Cli,
            Box::new(EnteredPanicStart(starts.clone())),
        )
        .err()
        .unwrap();
    let (error, disposition) = failure.into_disposition();
    assert_eq!(error, LeaseError::PersistenceFailed);
    let handle = match disposition {
        AdmissionDisposition::Owned(handle) => handle,
        _ => panic!("entered callback must keep original uncertain handle"),
    };
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        entered.observe_stop(&handle).err(),
        Some(LeaseError::ResourceStopPending)
    );
    assert_eq!(
        entered.lease_view(&handle).unwrap().status,
        LeaseStatus::HandoffUncertain
    );
    assert_eq!(actor_count(root.path()), 1);
    // Existing237 actual Started/FailedOwned/postcallback SQL rollback cases stay
    // byte-exact; this adds no alternate path around their original real joins.

    // V2 ND-PREVIEW-003: new extractor itself must carry the actual returned
    // owner on HandoffFailed AND both Started/FailedOwned status-write errors.
    for (failed_outcome, status_error) in [(true, false), (false, true), (true, true)] {
        let (_root, mut owner, effective) = relay();
        let starts = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicBool::new(false));
        let joined = Arc::new(AtomicBool::new(false));
        let (seen, _seen_rx) = mpsc::channel();
        let (exit, exit_rx) = mpsc::channel();
        if status_error {
            owner
                .fail_once(FailurePoint::AfterReturnedOwnerBeforeStatusCommit)
                .unwrap();
        }
        let failure = owner
            .admit(
                REQUEST_A,
                &effective,
                ConsumerKind::Cli,
                Box::new(ExtractedJoinCounterStart {
                    original: Box::new(PartialWorkerStart {
                        starts: starts.clone(),
                        fail_join_once: Arc::new(AtomicBool::new(false)),
                        failed_outcome,
                        running: running.clone(),
                        joined: joined.clone(),
                        stop_seen: seen,
                        exit_gate: exit_rx,
                    }),
                    calls: calls.clone(),
                }),
            )
            .err()
            .unwrap();
        let original_view = owner.admission_status(REQUEST_A).unwrap().unwrap();
        let was_running = running.load(Ordering::SeqCst);
        let was_joined = joined.load(Ordering::SeqCst);
        let (error, disposition) = failure.into_disposition();
        // ALL exit gates released before any actual join or causal assertion.
        let _ = exit.send(());
        let normal = match disposition {
            AdmissionDisposition::Owned(handle) => {
                let view = owner.lease_view(&handle);
                let released = owner.observe_stop(&handle).and_then(|proof| {
                    // Cached repeated observation must not call original owner twice.
                    owner.observe_stop(&handle)?;
                    owner.release_completed(&handle, &proof)
                });
                Some((view, released))
            }
            _ => None,
        };
        if !normal.as_ref().is_some_and(|(_, result)| result.is_ok()) {
            // Teardown ONLY for a faulty extractor: actual retained original owner
            // can be joined directly inside leases' private child, without minting
            // StopEvidence/repairing the missing handle/ACKing SQL. Normal result
            // is independently required below, so teardown cannot satisfy this test.
            owner.resources[0]
                .owner
                .as_mut()
                .unwrap()
                .cancel_and_join()
                .unwrap();
        }
        assert_eq!(
            error,
            if status_error {
                LeaseError::PersistenceFailed
            } else {
                LeaseError::HandoffFailed
            }
        );
        assert!(was_running);
        assert!(!was_joined);
        let (extracted_view, released) = normal
            .expect("new extractor must return Owned(original) for actual returned-owner failure");
        assert_eq!(extracted_view.unwrap(), original_view);
        released.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(joined.load(Ordering::SeqCst));
        assert!(!running.load(Ordering::SeqCst));
    }
}
