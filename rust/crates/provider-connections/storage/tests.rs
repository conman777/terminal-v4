use super::*;
use crate::fixtures::*;
use rusqlite::{params, types::Value};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::{
    fs,
    path::Path,
    sync::{Arc, Barrier},
};
use tempfile::TempDir;

const CREATE_OPERATION: &str = "60000000-0000-4000-8000-000000000009";
const DELETE_OPERATION: &str = "60000000-0000-4000-8000-000000000002";
const THIRD_REVISION: &str = "20000000-0000-4000-8000-000000000003";
const TABLES: &[&str] = &[
    "provider_connection_metadata",
    "provider_connection_profiles",
    "provider_connection_credentials",
    "provider_connection_tombstones",
    "provider_connection_operations",
    "provider_connection_revision_revocations",
    "provider_connection_discoveries",
    "provider_connection_actors",
];
fn private_root() -> TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
fn empty() -> (TempDir, FeatureStorage) {
    let root = private_root();
    let store = FeatureStorage::open(root.path()).unwrap();
    (root, store)
}
fn create(store: &mut FeatureStorage, owner: &Scope, kind: ProfileKind) -> ConfigReceipt {
    let auth = if kind == ProfileKind::ActualRelay {
        AuthChange::ReplaceBearer(synthetic_secret())
    } else {
        AuthChange::None
    };
    let mut request = update(kind, auth);
    request.operation_id = CREATE_OPERATION.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    store
        .mutate(
            owner,
            ConfigMutation::Put(request),
            save,
            &mut FakeCleanup::default(),
        )
        .unwrap()
}
fn relay() -> (TempDir, FeatureStorage) {
    let (root, mut store) = empty();
    create(&mut store, &scope(), ProfileKind::ActualRelay);
    (root, store)
}
fn replace() -> ConfigMutation {
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.expected_revision = Some(REVISION.into());
    ConfigMutation::Put(request)
}
fn delete(expected: &str) -> ConfigMutation {
    ConfigMutation::Delete(DeleteProfile {
        operation_id: DELETE_OPERATION.into(),
        profile_id: PROFILE.into(),
        expected_revision: expected.into(),
    })
}
fn count(store: &FeatureStorage, table: &str) -> i64 {
    store
        .repository
        .connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}
fn ciphertext(store: &FeatureStorage, owner: &Scope) -> String {
    store.repository.connection.query_row("SELECT ciphertext FROM provider_connection_credentials WHERE owner_id=?1 AND environment_id=?2",params![owner.owner_id,owner.environment_id],|row|row.get(0)).unwrap()
}
fn snapshot(store: &FeatureStorage) -> Vec<Vec<Vec<Value>>> {
    TABLES
        .iter()
        .map(|table| {
            let mut query = store
                .repository
                .connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = query.column_count();
            let rows = query
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| row.get::<_, Value>(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        })
        .collect()
}
fn seed_discovery(store: &FeatureStorage, owner: &Scope, revision: &str, request: &str) {
    store
        .repository
        .connection
        .execute(
            "INSERT INTO provider_connection_discoveries VALUES (?1,?2,?3,?4,?5,'running',0)",
            params![
                owner.owner_id,
                owner.environment_id,
                PROFILE,
                request,
                revision
            ],
        )
        .unwrap();
}
fn seed_actor(store: &FeatureStorage, revision: &str, generation: &str) {
    store
        .repository
        .connection
        .execute(
            "INSERT INTO provider_connection_actors VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'active',NULL)",
            params![
                scope().owner_id,
                scope().environment_id,
                PROFILE,
                "70000000-0000-4000-8000-000000000001",
                "70000000-0000-4000-8000-000000000002",
                "70000000-0000-4000-8000-000000000003",
                revision,
                generation
            ],
        )
        .unwrap();
}
fn schema_only(root: &Path) {
    let db = rusqlite::Connection::open(root.join(DATABASE_FILE)).unwrap();
    db.execute_batch(SCHEMA).unwrap();
    drop(db);
    fs::set_permissions(root.join(DATABASE_FILE), fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn fresh_store_has_private_database_key_and_versioned_key_verifier() {
    let (root, store) = empty();
    assert_eq!(
        fs::metadata(root.path().join(DATABASE_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(root.path().join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let version: i64 = store
        .repository
        .connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let verifier: Vec<u8> = store
        .repository
        .connection
        .query_row(
            "SELECT value FROM provider_connection_metadata WHERE name='key-verifier-v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(verifier.len(), 32);
    assert_eq!(store.evidence().unwrap().metadata_rows, 1);
}

#[test]
fn local_none_profile_is_durable_without_a_credential_or_inference_claim() {
    let (root, mut store) = empty();
    let saved = create(&mut store, &scope(), ProfileKind::ActualLocal);
    assert!(saved.settings_saved && saved.cleanup_confirmed);
    assert_eq!(count(&store, "provider_connection_credentials"), 0);
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    let profile = reopened.profile(&scope(), PROFILE).unwrap().unwrap();
    assert_eq!(profile.kind, ProfileKind::ActualLocal);
    assert_eq!(profile.auth, StoredAuth::None);
    assert!(matches!(
        reopened
            .authorization(&scope(), &reference_for(&profile))
            .unwrap(),
        ResolvedAuthorization::None
    ));
    assert_eq!(
        profiles::public_profile(&profile).unwrap()["inferenceVerified"],
        false
    );
}

#[test]
fn relay_round_trip_uses_only_aead_rows_and_bound_typed_authorization() {
    let (root, mut store) = relay();
    let row = ciphertext(&store, &scope());
    assert!(row.starts_with("enc:v1:") && !row.contains("synthetic-test-token"));
    let profile = store.profile(&scope(), PROFILE).unwrap().unwrap();
    let auth = store
        .authorization(&scope(), &reference_for(&profile))
        .unwrap();
    match auth {
        ResolvedAuthorization::Bearer(secret) => {
            assert_eq!(secret.expose_for_adapter(), "synthetic-test-token")
        }
        _ => panic!("expected bound bearer"),
    };
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    assert!(matches!(
        reopened
            .authorization(&scope(), &reference_for(&profile))
            .unwrap(),
        ResolvedAuthorization::Bearer(_)
    ));
}

#[test]
fn colliding_profile_and_credential_ids_in_another_owner_or_environment_are_isolated() {
    let (_root, mut store) = relay();
    for foreign in [
        Scope {
            owner_id: "other-owner".into(),
            ..scope()
        },
        Scope {
            environment_id: "other-environment".into(),
            ..scope()
        },
    ] {
        assert!(store.profile(&foreign, PROFILE).unwrap().is_none());
        create(&mut store, &foreign, ProfileKind::ActualRelay);
        let own = store.profile(&scope(), PROFILE).unwrap().unwrap();
        assert_eq!(
            store.authorization(&foreign, &reference_for(&own)).err(),
            Some(Error::InvalidScope)
        );
    }
    assert_eq!(count(&store, "provider_connection_profiles"), 3);
    assert_eq!(count(&store, "provider_connection_credentials"), 3);
}

#[test]
fn lost_mutation_response_is_lookup_recoverable_and_identical_retry_never_seals_again() {
    let (root, mut store) = relay();
    let saved = store
        .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
        .unwrap();
    let encrypted = ciphertext(&store, &scope());
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    let recovered = reopened
        .operation_status(&scope(), PROFILE, OPERATION)
        .unwrap();
    assert_eq!(recovered, saved);
    let before = reopened.metrics_for_test().unwrap();
    let repeated = reopened
        .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
        .unwrap();
    assert_eq!(repeated, recovered);
    assert_eq!(reopened.metrics_for_test().unwrap(), before);
    assert!(ciphertext(&reopened, &scope()) == encrypted);
    assert_eq!(count(&reopened, "provider_connection_operations"), 2);
    assert_eq!(count(&reopened, "provider_connection_credentials"), 1);
}

#[test]
fn reused_operation_id_with_changed_secret_conflicts_before_cas_or_encryption() {
    let (_root, mut store) = relay();
    store
        .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
        .unwrap();
    let before = snapshot(&store);
    let metrics = store.metrics_for_test().unwrap();
    let mut changed = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(SecretString::new("other-synthetic-secret".into())),
    );
    changed.expected_revision = Some(REVISION.into());
    assert_eq!(
        store
            .mutate(
                &scope(),
                ConfigMutation::Put(changed),
                ids(),
                &mut FakeCleanup::default()
            )
            .err(),
        Some(Error::OperationConflict)
    );
    assert!(snapshot(&store) == before);
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
}

#[test]
fn stale_revision_fails_before_any_real_seal_attempt_or_database_write() {
    let (_root, mut store) = relay();
    let before = snapshot(&store);
    let metrics = store.metrics_for_test().unwrap();
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.expected_revision = Some(THIRD_REVISION.into());
    assert_eq!(
        store
            .mutate(
                &scope(),
                ConfigMutation::Put(request),
                ids(),
                &mut FakeCleanup::default()
            )
            .err(),
        Some(Error::RevisionConflict)
    );
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
    assert!(snapshot(&store) == before);
}

#[test]
fn simultaneous_identical_operations_across_two_sqlite_handles_commit_one_rotation() {
    let (root, store) = relay();
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = vec![];
    for _ in 0..2 {
        let mut store = FeatureStorage::open(root.path()).unwrap();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            store
                .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
                .unwrap()
        }));
    }
    let a = handles.remove(0).join().unwrap();
    let b = handles.remove(0).join().unwrap();
    assert_eq!(a, b);
    let store = FeatureStorage::open(root.path()).unwrap();
    assert_eq!(count(&store, "provider_connection_operations"), 2);
    assert_eq!(count(&store, "provider_connection_credentials"), 1);
    assert_eq!(
        store.profile(&scope(), PROFILE).unwrap().unwrap().revision,
        NEXT_REVISION
    );
}

#[test]
fn different_concurrent_operations_on_one_expected_revision_have_one_winner() {
    let (root, store) = relay();
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = vec![];
    for index in 0..2 {
        let mut store = FeatureStorage::open(root.path()).unwrap();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let mut request = update(
                ProfileKind::ActualRelay,
                AuthChange::ReplaceBearer(synthetic_secret()),
            );
            request.expected_revision = Some(REVISION.into());
            if index == 1 {
                request.operation_id = "60000000-0000-4000-8000-000000000003".into();
            }
            barrier.wait();
            store.mutate(
                &scope(),
                ConfigMutation::Put(request),
                ids(),
                &mut FakeCleanup::default(),
            )
        }));
    }
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .collect::<Vec<_>>(),
        vec![&Error::RevisionConflict]
    );
    let store = FeatureStorage::open(root.path()).unwrap();
    assert_eq!(count(&store, "provider_connection_operations"), 2);
    assert_eq!(count(&store, "provider_connection_credentials"), 1);
}

#[test]
fn every_precommit_sql_failpoint_rolls_back_profile_vault_revocations_receipt_and_jobs() {
    for point in [
        TestFailurePoint::AfterProfileWrite,
        TestFailurePoint::AfterCredentialWrite,
        TestFailurePoint::AfterRevocationWrite,
        TestFailurePoint::AfterOperationWrite,
        TestFailurePoint::AfterDiscoveryCancellation,
        TestFailurePoint::BeforeCommit,
    ] {
        let (_root, mut store) = relay();
        seed_discovery(&store, &scope(), REVISION, REQUEST);
        seed_actor(&store, REVISION, GENERATION);
        let before = snapshot(&store);
        store.fail_once(point);
        assert_eq!(
            store
                .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
                .err(),
            Some(Error::PersistenceFailed)
        );
        assert!(snapshot(&store) == before);
        assert!(store.repository.connection.is_autocommit());
    }
}

#[test]
fn delete_tombstone_and_credential_removal_roll_back_together_on_failure() {
    let (_root, mut store) = relay();
    let before = snapshot(&store);
    store.fail_once(TestFailurePoint::AfterTombstoneWrite);
    assert_eq!(
        store
            .mutate(
                &scope(),
                delete(REVISION),
                ids(),
                &mut FakeCleanup::default()
            )
            .err(),
        Some(Error::PersistenceFailed)
    );
    assert!(snapshot(&store) == before);
    assert!(store.repository.connection.is_autocommit());
}

#[test]
fn ambiguous_postcommit_ack_is_reconciled_by_durable_lookup_without_reencryption() {
    let (root, mut store) = relay();
    store.fail_once(TestFailurePoint::AfterCommitBeforeReceipt);
    assert_eq!(
        store
            .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
            .err(),
        Some(Error::PersistenceFailed)
    );
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    let saved = reopened
        .operation_status(&scope(), PROFILE, OPERATION)
        .unwrap();
    assert!(saved.settings_saved);
    let ciphertext_before = ciphertext(&reopened, &scope());
    let metrics = reopened.metrics_for_test().unwrap();
    let retry = reopened
        .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
        .unwrap();
    assert_eq!(retry.operation_id, saved.operation_id);
    assert_eq!(reopened.metrics_for_test().unwrap(), metrics);
    assert!(ciphertext(&reopened, &scope()) == ciphertext_before);
    assert_eq!(count(&reopened, "provider_connection_operations"), 2);
}

#[test]
fn committed_replacement_detaches_old_generation_and_revokes_only_matching_discoveries() {
    let (_root, mut store) = relay();
    seed_discovery(&store, &scope(), REVISION, REQUEST);
    let mut foreign = scope();
    foreign.owner_id = "other-owner".into();
    seed_discovery(&store, &foreign, REVISION, REQUEST);
    seed_discovery(
        &store,
        &scope(),
        THIRD_REVISION,
        "50000000-0000-4000-8000-000000000002",
    );
    store
        .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
        .unwrap();
    let current = store.profile(&scope(), PROFILE).unwrap().unwrap();
    match current.auth {
        StoredAuth::Bearer(binding) => assert_eq!(binding.generation, NEXT_GENERATION),
        _ => panic!("missing bearer"),
    };
    assert_eq!(count(&store, "provider_connection_credentials"), 1);
    assert_eq!(count(&store, "provider_connection_revision_revocations"), 1);
    let flags=store.repository.connection.prepare("SELECT owner_id,config_revision,cancel_requested FROM provider_connection_discoveries ORDER BY rowid").unwrap().query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(
        flags,
        vec![
            (scope().owner_id, REVISION.into(), 1),
            (foreign.owner_id, REVISION.into(), 0),
            (scope().owner_id, THIRD_REVISION.into(), 0)
        ]
    );
}

#[test]
fn pending_cleanup_survives_reopen_and_retry_uses_only_original_operation_targets() {
    let (root, mut store) = relay();
    let pending = store
        .mutate(
            &scope(),
            replace(),
            ids(),
            &mut FakeCleanup {
                fail: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(pending.settings_saved && !pending.cleanup_confirmed);
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    let metrics = reopened.metrics_for_test().unwrap();
    let mut cleanup = FakeCleanup::default();
    let finished = reopened
        .retry_cleanup(&scope(), PROFILE, OPERATION, &mut cleanup)
        .unwrap();
    assert!(finished.cleanup_confirmed);
    assert_eq!(cleanup.calls, 1);
    assert_eq!(reopened.metrics_for_test().unwrap(), metrics);
    assert_eq!(count(&reopened, "provider_connection_operations"), 2);
    assert_eq!(
        reopened
            .profile(&scope(), PROFILE)
            .unwrap()
            .unwrap()
            .activation,
        Activation::Ready
    );
}

#[test]
fn deleting_pending_b_durably_captures_a_b_and_required_lease_ids_without_claiming_stop() {
    let (root, mut store) = relay();
    seed_actor(&store, REVISION, GENERATION);
    store
        .mutate(
            &scope(),
            replace(),
            ids(),
            &mut FakeCleanup {
                fail: true,
                ..Default::default()
            },
        )
        .unwrap();
    let mut saved_ids = ids();
    saved_ids.revision = THIRD_REVISION.into();
    let deleted = store
        .mutate(
            &scope(),
            delete(NEXT_REVISION),
            saved_ids,
            &mut FakeCleanup::default(),
        )
        .unwrap();
    assert!(deleted.settings_saved && deleted.deleted && !deleted.cleanup_confirmed);
    drop(store);
    let reopened = FeatureStorage::open(root.path()).unwrap();
    let operation = reopened
        .repository
        .operation(&scope(), PROFILE, DELETE_OPERATION)
        .unwrap()
        .unwrap();
    assert_eq!(
        operation
            .revocations
            .targets
            .iter()
            .map(|target| target.connection.revision.as_str())
            .collect::<Vec<_>>(),
        vec![REVISION, NEXT_REVISION]
    );
    assert_eq!(operation.revocations.targets[0].leases.len(), 1);
    assert_eq!(
        operation.revocations.targets[0].leases[0].lease_id,
        "70000000-0000-4000-8000-000000000003"
    );
    assert!(reopened.profile(&scope(), PROFILE).unwrap().is_none());
    assert_eq!(count(&reopened, "provider_connection_credentials"), 0);
}

#[test]
fn committed_operation_identity_and_cleanup_target_snapshot_cannot_be_rewritten_or_evicted() {
    let (_root, mut store) = relay();
    store
        .mutate(
            &scope(),
            replace(),
            ids(),
            &mut FakeCleanup {
                fail: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(store
        .repository
        .connection
        .execute(
            "UPDATE provider_connection_operations SET revocations_json='[]' WHERE operation_id=?1",
            [OPERATION]
        )
        .is_err());
    assert!(store
        .repository
        .connection
        .execute(
            "DELETE FROM provider_connection_operations WHERE operation_id=?1",
            [OPERATION]
        )
        .is_err());
    let saved = store
        .operation_status(&scope(), PROFILE, OPERATION)
        .unwrap();
    assert!(saved.settings_saved && !saved.cleanup_confirmed);
}

#[test]
fn deletion_is_durable_deduplicated_and_cannot_recreate_the_profile_or_old_key() {
    let (root, mut store) = relay();
    let saved = store
        .mutate(
            &scope(),
            delete(REVISION),
            ids(),
            &mut FakeCleanup::default(),
        )
        .unwrap();
    assert!(saved.deleted);
    drop(store);
    let mut reopened = FeatureStorage::open(root.path()).unwrap();
    let retry = reopened
        .mutate(
            &scope(),
            delete(REVISION),
            ids(),
            &mut FakeCleanup::default(),
        )
        .unwrap();
    assert_eq!(retry, saved);
    assert_eq!(count(&reopened, "provider_connection_credentials"), 0);
    assert_eq!(count(&reopened, "provider_connection_tombstones"), 1);
    let mut request = update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.operation_id = "60000000-0000-4000-8000-000000000004".into();
    assert_eq!(
        reopened
            .mutate(
                &scope(),
                ConfigMutation::Put(request),
                ids(),
                &mut FakeCleanup::default()
            )
            .err(),
        Some(Error::NotFound)
    );
}

#[test]
fn missing_key_with_none_profile_or_retained_hmac_receipt_never_regenerates() {
    for receipt_only in [false, true] {
        let (root, mut store) = empty();
        create(&mut store, &scope(), ProfileKind::LmStudioLocal);
        if receipt_only {
            store
                .repository
                .connection
                .execute("DELETE FROM provider_connection_profiles", [])
                .unwrap();
        }
        drop(store);
        fs::remove_file(root.path().join(KEY_FILE)).unwrap();
        assert_eq!(
            FeatureStorage::open(root.path()).err(),
            Some(Error::KeyUnavailable)
        );
        assert!(!root.path().join(KEY_FILE).exists());
    }
}

#[test]
fn wrong_well_formed_key_with_none_profile_is_detected_before_any_mutation() {
    let (root, mut store) = empty();
    create(&mut store, &scope(), ProfileKind::LmStudioLocal);
    drop(store);
    fs::write(
        root.path().join(KEY_FILE),
        format!("{}{}", KEY_PREFIX, hex::encode([0x55; 32])),
    )
    .unwrap();
    assert_eq!(
        FeatureStorage::open(root.path()).err(),
        Some(Error::KeyUnavailable)
    );
}

#[test]
fn unknown_schema_or_failed_feature_evidence_never_looks_like_an_empty_store() {
    for broken in [false, true] {
        let root = private_root();
        schema_only(root.path());
        let db = rusqlite::Connection::open(root.path().join(DATABASE_FILE)).unwrap();
        db.execute_batch(if broken {
            "DROP TABLE provider_connection_operations"
        } else {
            "PRAGMA user_version=999"
        })
        .unwrap();
        drop(db);
        assert_eq!(
            FeatureStorage::open(root.path()).err(),
            Some(Error::PersistenceFailed)
        );
        assert!(!root.path().join(KEY_FILE).exists());
    }
}

#[test]
fn database_symlink_or_hardlink_is_rejected_before_sqlite_writes() {
    for hardlink in [false, true] {
        let root = private_root();
        let target = root.path().join("synthetic-db-target");
        fs::write(&target, "untouched").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        if hardlink {
            fs::hard_link(&target, root.path().join(DATABASE_FILE)).unwrap();
        } else {
            symlink(&target, root.path().join(DATABASE_FILE)).unwrap();
        }
        assert_eq!(
            FeatureStorage::open(root.path()).err(),
            Some(Error::PersistenceFailed)
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
    }
}

#[test]
fn malformed_or_tampered_ciphertext_never_falls_back_to_plaintext_legacy_or_environment_keys() {
    let (_root, mut store) = relay();
    let profile = store.profile(&scope(), PROFILE).unwrap().unwrap();
    store.repository.connection.execute_batch("CREATE TABLE api_key_vault(provider TEXT,secret TEXT); INSERT INTO api_key_vault VALUES ('actual','synthetic-legacy-token');").unwrap();
    for bad in [
        "synthetic-plaintext-token",
        "enc:v1:000000000000000000000000:00000000000000000000000000000000",
    ] {
        store
            .repository
            .connection
            .execute(
                "UPDATE provider_connection_credentials SET ciphertext=?1",
                [bad],
            )
            .unwrap();
        let error = store
            .authorization(&scope(), &reference_for(&profile))
            .err();
        assert!(matches!(
            error,
            Some(Error::EncryptedCredentialRequired | Error::InvalidCredential)
        ));
    }
    let legacy: String = store
        .repository
        .connection
        .query_row("SELECT secret FROM api_key_vault", [], |row| row.get(0))
        .unwrap();
    assert_eq!(legacy, "synthetic-legacy-token");
}

#[test]
fn operation_capacity_is_checked_before_real_encryption_but_final_delete_is_reserved() {
    let (_root, mut store) = relay();
    let operation = store
        .repository
        .operation(&scope(), PROFILE, CREATE_OPERATION)
        .unwrap()
        .unwrap();
    let record=store.repository.connection.query_row("SELECT action,payload_tag,saved_revision,receipt_json,revoked_json,revocations_json,cleanup_confirmed FROM provider_connection_operations WHERE operation_id=?1",[CREATE_OPERATION],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,String>(5)?,row.get::<_,i64>(6)?))).unwrap();
    for index in 1..1024 {
        let id = format!("60000000-0000-4000-8001-{index:012x}");
        let receipt = record.3.replace(CREATE_OPERATION, &id);
        store.repository.connection.execute("INSERT INTO provider_connection_operations VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![scope().owner_id,scope().environment_id,PROFILE,id,record.0,record.1,record.2,receipt,record.4,record.5,record.6]).unwrap();
    }
    let metrics = store.metrics_for_test().unwrap();
    assert_eq!(
        store
            .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
            .err(),
        Some(Error::CapacityReached)
    );
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
    let saved = store
        .mutate(
            &scope(),
            delete(REVISION),
            ids(),
            &mut FakeCleanup::default(),
        )
        .unwrap();
    assert!(saved.deleted);
    assert_eq!(count(&store, "provider_connection_operations"), 1025);
    assert_eq!(operation.receipt.profile_id, PROFILE);
}

#[test]
fn changed_endpoint_cannot_reuse_an_optional_local_bearer_ciphertext() {
    let (_root, mut store) = empty();
    let mut request = update(
        ProfileKind::LmStudioLocal,
        AuthChange::ReplaceBearer(synthetic_secret()),
    );
    request.operation_id = CREATE_OPERATION.into();
    let mut save = ids();
    save.revision = REVISION.into();
    save.credential_id = CREDENTIAL.into();
    save.credential_generation = GENERATION.into();
    store
        .mutate(
            &scope(),
            ConfigMutation::Put(request),
            save,
            &mut FakeCleanup::default(),
        )
        .unwrap();
    let before = snapshot(&store);
    let metrics = store.metrics_for_test().unwrap();
    let mut request = update(ProfileKind::LmStudioLocal, AuthChange::KeepBearer);
    request.expected_revision = Some(REVISION.into());
    request.base_url = "http://127.0.0.1:1235/v1".into();
    assert_eq!(
        store
            .mutate(
                &scope(),
                ConfigMutation::Put(request),
                ids(),
                &mut FakeCleanup::default()
            )
            .err(),
        Some(Error::CredentialTargetChanged)
    );
    assert!(snapshot(&store) == before);
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
}

#[test]
fn profile_capacity_counts_tombstones_within_scope_before_encryption() {
    let (_root, mut store) = empty();
    for index in 0..128 {
        let profile_id = format!("11000000-0000-4000-8000-{index:012x}");
        let operation_id = format!("61000000-0000-4000-8000-{index:012x}");
        store
            .repository
            .connection
            .execute(
                "INSERT INTO provider_connection_tombstones VALUES (?1,?2,?3,?4,?5)",
                params![
                    scope().owner_id,
                    scope().environment_id,
                    profile_id,
                    REVISION,
                    operation_id
                ],
            )
            .unwrap();
    }
    let metrics = store.metrics_for_test().unwrap();
    let request = ConfigMutation::Put(update(
        ProfileKind::ActualRelay,
        AuthChange::ReplaceBearer(synthetic_secret()),
    ));
    assert_eq!(
        store
            .mutate(&scope(), request, ids(), &mut FakeCleanup::default())
            .err(),
        Some(Error::CapacityReached)
    );
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
    assert_eq!(count(&store, "provider_connection_profiles"), 0);
    assert_eq!(count(&store, "provider_connection_tombstones"), 128);
    let foreign = Scope {
        owner_id: "other-owner".into(),
        ..scope()
    };
    create(&mut store, &foreign, ProfileKind::ActualRelay);
    assert_eq!(count(&store, "provider_connection_profiles"), 1);
}

#[test]
fn two_fresh_store_opens_share_one_key_and_verifier_without_partial_schema() {
    let root = private_root();
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = vec![];
    for _ in 0..2 {
        let path = root.path().to_path_buf();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            let store = FeatureStorage::open(&path).unwrap();
            store
                .repository
                .connection
                .query_row(
                    "SELECT value FROM provider_connection_metadata WHERE name='key-verifier-v1'",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .unwrap()
        }));
    }
    let first = handles.remove(0).join().unwrap();
    let second = handles.remove(0).join().unwrap();
    assert_eq!(first, second);
    assert_eq!(first.len(), 32);
    let store = FeatureStorage::open(root.path()).unwrap();
    assert_eq!(count(&store, "provider_connection_metadata"), 1);
}

#[test]
fn unsafe_key_for_a_retained_none_profile_is_rejected_without_losing_saved_state() {
    for mode in ["public", "symlink", "hardlink"] {
        let (root, mut store) = empty();
        create(&mut store, &scope(), ProfileKind::ActualLocal);
        drop(store);
        let key = root.path().join(KEY_FILE);
        match mode {
            "public" => fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap(),
            "symlink" => {
                let target = root.path().join("synthetic-key-target");
                fs::rename(&key, &target).unwrap();
                symlink(target, &key).unwrap();
            }
            _ => fs::hard_link(&key, root.path().join("synthetic-key-link")).unwrap(),
        }
        assert_eq!(
            FeatureStorage::open(root.path()).err(),
            Some(Error::KeyUnavailable)
        );
        let db = rusqlite::Connection::open(root.path().join(DATABASE_FILE)).unwrap();
        let profiles: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM provider_connection_profiles",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(profiles, 1);
    }
}

#[test]
fn mismatched_persisted_binding_json_cannot_authorize_the_indexed_credential_row() {
    let (_root, mut store) = relay();
    let current = store.profile(&scope(), PROFILE).unwrap().unwrap();
    store
        .repository
        .connection
        .execute(
            "UPDATE provider_connection_credentials SET binding_json=?1",
            [r#"{"ownerId":"other-owner"}"#],
        )
        .unwrap();
    assert!(matches!(
        store
            .authorization(&scope(), &reference_for(&current))
            .err(),
        Some(Error::InvalidCredential | Error::CredentialBindingMismatch)
    ));
}

#[test]
fn persisted_feature_rows_never_contain_plaintext_secret_or_master_key() {
    let (root, mut store) = relay();
    store
        .mutate(
            &scope(),
            replace(),
            ids(),
            &mut FakeCleanup {
                fail: true,
                ..Default::default()
            },
        )
        .unwrap();
    let key_file = fs::read_to_string(root.path().join(KEY_FILE)).unwrap();
    let key_hex = key_file.strip_prefix(KEY_PREFIX).unwrap();
    for value in snapshot(&store).into_iter().flatten().flatten() {
        let bytes = match value {
            Value::Text(text) => text.into_bytes(),
            Value::Blob(bytes) => bytes,
            _ => continue,
        };
        assert!(!bytes
            .windows(b"synthetic-test-token".len())
            .any(|window| window == b"synthetic-test-token"));
        assert!(!bytes
            .windows(key_hex.len())
            .any(|window| window == key_hex.as_bytes()));
    }
}

#[test]
fn sqlite_nofollow_rejects_an_ancestor_alias_but_accepts_the_canonical_private_root() {
    let container = private_root();
    let actual_parent = container.path().join("actual-parent");
    fs::create_dir(&actual_parent).unwrap();
    fs::set_permissions(&actual_parent, fs::Permissions::from_mode(0o700)).unwrap();
    let canonical_root = actual_parent.join("feature");
    fs::create_dir(&canonical_root).unwrap();
    fs::set_permissions(&canonical_root, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(canonical_root.canonicalize().unwrap(), canonical_root);
    let alias_parent = container.path().join("parent-alias");
    symlink(&actual_parent, &alias_parent).unwrap();
    let alias_root = alias_parent.join("feature");
    assert_eq!(alias_root.canonicalize().unwrap(), canonical_root);
    assert!(fs::symlink_metadata(&alias_root).unwrap().is_dir());
    let database = canonical_root.join(DATABASE_FILE);
    fs::write(&database, []).unwrap();
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
        | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
    match rusqlite::Connection::open_with_flags(alias_root.join(DATABASE_FILE), flags) {
        Err(rusqlite::Error::SqliteFailure(error, _)) => {
            assert_eq!(error.extended_code, rusqlite::ffi::SQLITE_CANTOPEN_SYMLINK);
        }
        _ => panic!("NOFOLLOW must reject the synthetic ancestor alias"),
    }
    let canonical_connection = rusqlite::Connection::open_with_flags(&database, flags).unwrap();
    drop(canonical_connection);
    assert_eq!(
        FeatureStorage::open(&alias_root).err(),
        Some(Error::PersistenceFailed)
    );
    let store = FeatureStorage::open(&canonical_root).unwrap();
    assert_eq!(store.evidence().unwrap().metadata_rows, 1);
}

fn cleanup_activation_abort_keeps_receipt_pending(identical_mutation_retry: bool) {
    let (root, mut store) = relay();
    let saved = store
        .mutate(
            &scope(),
            replace(),
            ids(),
            &mut FakeCleanup {
                fail: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(saved.settings_saved && !saved.cleanup_confirmed);
    let metrics = store.metrics_for_test().unwrap();
    let encrypted = ciphertext(&store, &scope());
    store.repository.connection.execute_batch(
        "CREATE TRIGGER provider_connection_test_abort_activation BEFORE UPDATE OF record_json ON provider_connection_profiles BEGIN SELECT RAISE(ABORT,'synthetic activation failure'); END;"
    ).unwrap();
    let failed_ack = if identical_mutation_retry {
        store
            .mutate(&scope(), replace(), ids(), &mut FakeCleanup::default())
            .unwrap()
    } else {
        store
            .retry_cleanup(&scope(), PROFILE, OPERATION, &mut FakeCleanup::default())
            .unwrap()
    };
    let verifier = rusqlite::Connection::open(root.path().join(DATABASE_FILE)).unwrap();
    let durable_flag: i64 = verifier.query_row(
        "SELECT cleanup_confirmed FROM provider_connection_operations WHERE owner_id=?1 AND environment_id=?2 AND profile_id=?3 AND operation_id=?4",
        params![scope().owner_id, scope().environment_id, PROFILE, OPERATION], |row| row.get(0)
    ).unwrap();
    drop(verifier);
    let pending_activation = store
        .profile(&scope(), PROFILE)
        .unwrap()
        .unwrap()
        .activation;
    let after_failure_metrics = store.metrics_for_test().unwrap();
    store
        .repository
        .connection
        .execute_batch("DROP TRIGGER provider_connection_test_abort_activation")
        .unwrap();
    let completed = store
        .retry_cleanup(&scope(), PROFILE, OPERATION, &mut FakeCleanup::default())
        .unwrap();
    let final_activation = store
        .profile(&scope(), PROFILE)
        .unwrap()
        .unwrap()
        .activation;
    assert!(failed_ack.settings_saved && !failed_ack.cleanup_confirmed);
    assert_eq!(failed_ack.operation_id, saved.operation_id);
    assert_eq!(failed_ack.saved_revision, saved.saved_revision);
    assert_eq!(
        durable_flag, 0,
        "failed activation must not persist a cleanup confirmation"
    );
    assert_eq!(pending_activation, Activation::CleanupPending);
    assert_eq!(after_failure_metrics, metrics);
    assert!(completed.settings_saved && completed.cleanup_confirmed);
    assert_eq!(completed.operation_id, saved.operation_id);
    assert_eq!(completed.saved_revision, saved.saved_revision);
    assert_eq!(final_activation, Activation::Ready);
    assert_eq!(store.metrics_for_test().unwrap(), metrics);
    assert_eq!(ciphertext(&store, &scope()), encrypted);
    assert_eq!(count(&store, "provider_connection_operations"), 2);
}

#[test]
fn explicit_cleanup_retry_activation_abort_cannot_commit_a_partial_confirmation() {
    cleanup_activation_abort_keeps_receipt_pending(false);
}

#[test]
fn identical_mutation_retry_activation_abort_cannot_commit_a_partial_confirmation() {
    cleanup_activation_abort_keeps_receipt_pending(true);
}

#[test]
fn sqlite_auxiliary_fifo_is_rejected_before_any_writer_without_hanging_cleanup() {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, OpenOptionsExt},
    };
    use std::sync::mpsc;
    use std::time::Duration;
    let (root, store) = empty();
    drop(store);
    let fifo = root.path().join(format!("{DATABASE_FILE}-journal"));
    let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
    let path = root.path().to_path_buf();
    let (sender, receiver) = mpsc::channel();
    let worker =
        std::thread::spawn(move || sender.send(FeatureStorage::open(&path).err()).unwrap());
    let before_writer = receiver.recv_timeout(Duration::from_secs(1));
    let rejected_before_writer = before_writer.is_ok();
    let result = match before_writer {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // Only after recording the no-writer timeout, release the blocked
            // synthetic reader so a red result never leaves a hanging worker.
            let cleanup = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
                .open(&fifo)
                .unwrap();
            drop(cleanup);
            receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("owned FIFO cleanup must release worker")
        }
        Err(error) => panic!("FIFO worker disconnected: {error}"),
    };
    worker.join().unwrap();
    fs::remove_file(&fifo).unwrap();
    assert!(
        rejected_before_writer,
        "auxiliary FIFO must be rejected without waiting for a writer"
    );
    assert_eq!(result, Some(Error::PersistenceFailed));
}
