//! UNAPPLIED child-of-jobs tests. Uses existing APIs only; no new method stubs.
use super::*;
use crate::fixtures::*;
use serde_json::json;

fn active() -> (JobStore, Job, WorkerPermit, StoredProfile) {
    let current = profile(ProfileKind::ActualRelay);
    let snapshot = runtime::resolve(&scope(), &current, &reference_for(&current), None).unwrap();
    let mut store = JobStore::new();
    let queued = begin(&mut store, &scope(), &snapshot, REQUEST, 1).unwrap();
    let permit = dispatch(&mut store, &queued.key, Some(&current)).unwrap();
    (store, queued, permit, current)
}
fn receipt(job: &Job) -> discovery::InventoryReceipt {
    let plan = job.plan.as_ref().unwrap();
    discovery::InventoryReceipt {
        binding: plan.binding.clone(),
        kind: plan.requests[0].kind,
        effective_url: plan.requests[0].url.clone(),
        body: serde_json::to_vec(&json!({"data":[{"id":"synthetic-should-never-publish"}]}))
            .unwrap(),
    }
}
fn authoritative(store: &JobStore, key: &JobKey) -> Job {
    store
        .records
        .iter()
        .find(|job| job.key == *key)
        .unwrap()
        .clone()
}
fn assert_unpublished_active_failure(
    store: &JobStore,
    key: &JobKey,
    status: Status,
    code: &str,
) -> Job {
    let saved = authoritative(store, key);
    assert_eq!(saved.status, status);
    assert_eq!(
        saved.io,
        IoState::Active,
        "publication failure alone cannot prove transport stop"
    );
    assert!(
        saved.worker_generation.is_none(),
        "publication authority must be consumed"
    );
    assert_eq!(
        saved.completed_ms,
        Some(3),
        "timestamp describes publication outcome only"
    );
    assert!(saved.catalog.is_none() && saved.receipt.is_none());
    let dto = public_job(store, key, &scope()).unwrap();
    assert_eq!(dto["cleanupPending"], true);
    assert_eq!(dto["cancelConfirmed"], false);
    assert_eq!(dto["error"]["code"], code);
    assert!(dto["models"].is_null() && dto["receipt"].is_null());
    assert!(!dto.to_string().contains("synthetic-sensitive-response"));
    saved
}

#[test]
fn completion_receipt_error_consumes_publication_and_exact_replay_cannot_parse_or_publish_a_later_body(
) {
    for invalid in ["json", "binding", "redirect", "count", "missing-primary"] {
        let (mut store, queued, permit, current) = active();
        let mut invalid_receipt = receipt(&queued);
        let attempted = if invalid == "count" { 2 } else { 1 };
        match invalid {
            "json" => invalid_receipt.body = b"{synthetic-sensitive-response".to_vec(),
            "binding" => invalid_receipt.binding.owner_id = "other-synthetic-owner".into(),
            "redirect" => {
                invalid_receipt.effective_url = "https://other.example.test/v1/models".into()
            }
            _ => {}
        }
        let receipts = if invalid == "missing-primary" {
            vec![]
        } else {
            vec![invalid_receipt]
        };
        assert_eq!(
            finish(
                &mut store,
                &permit,
                Some(&current),
                &receipts,
                attempted,
                true,
                3
            ),
            Err(Error::InvalidReceipt)
        );
        let failed = assert_unpublished_active_failure(
            &store,
            &queued.key,
            Status::Failed,
            "inventory_rejected",
        );
        // V2 cached-error generation fence BEGIN
        // Same live store and same key, but never the failure's generation.
        let other_generation = WorkerPermit {
            key: permit.key.clone(),
            generation: permit.generation + 1,
            store_identity: permit.store_identity.clone(),
        };
        let valid_for_forgery = receipt(&queued);
        assert_eq!(
            finish(
                &mut store,
                &other_generation,
                Some(&current),
                &[valid_for_forgery],
                1,
                true,
                98
            ),
            Err(Error::StaleResult)
        );
        assert_eq!(authoritative(&store, &queued.key), failed);
        // V2 cached-error generation fence END
        // Root-approved bounded error replay: same live store/key/generation
        // returns the original typed error without examining replacement input.
        let valid = receipt(&queued);
        assert_eq!(
            finish(&mut store, &permit, Some(&current), &[valid], 1, true, 99),
            Err(Error::InvalidReceipt)
        );
        assert_eq!(authoritative(&store, &queued.key), failed);
        // If complete were called again, this combination returns CleanupPending
        // before parsing. Exact old InvalidReceipt proves read-only error replay.
        let mut unparseable = receipt(&queued);
        unparseable.body = b"not-json-synthetic-sensitive-response".to_vec();
        assert_eq!(
            finish(&mut store, &permit, None, &[unparseable], 0, false, 100),
            Err(Error::InvalidReceipt)
        );
        assert_eq!(authoritative(&store, &queued.key), failed);
    }
}

#[test]
fn stale_profile_completion_closes_the_generation_even_if_the_original_profile_is_later_supplied() {
    let (mut store, queued, permit, current) = active();
    let mut changed = current.clone();
    changed.revision = NEXT_REVISION.into();
    let mut unparseable = receipt(&queued);
    unparseable.body = b"synthetic-sensitive-response-invalid-json".to_vec();
    assert_eq!(
        finish(
            &mut store,
            &permit,
            Some(&changed),
            &[unparseable],
            1,
            true,
            3
        ),
        Err(Error::StaleResult)
    );
    let stale = assert_unpublished_active_failure(
        &store,
        &queued.key,
        Status::Stale,
        "configuration_changed",
    );
    let valid = receipt(&queued);
    assert_eq!(
        finish(&mut store, &permit, Some(&current), &[valid], 1, true, 4),
        Err(Error::StaleResult)
    );
    assert_eq!(authoritative(&store, &queued.key), stale);
}

#[test]
fn incomplete_transport_error_closes_only_publication_and_cannot_be_released_by_a_later_boolean() {
    let (mut store, queued, permit, current) = active();
    let valid = receipt(&queued);
    assert_eq!(
        finish(
            &mut store,
            &permit,
            Some(&current),
            std::slice::from_ref(&valid),
            1,
            false,
            3
        ),
        Err(Error::CleanupPending)
    );
    let failed = assert_unpublished_active_failure(
        &store,
        &queued.key,
        Status::Failed,
        "transport_not_stopped",
    );
    assert_eq!(
        finish(&mut store, &permit, Some(&current), &[valid], 1, true, 4),
        Err(Error::CleanupPending)
    );
    assert_eq!(authoritative(&store, &queued.key), failed);
    assert_eq!(cancel(&mut store, &queued.key, 5).unwrap(), failed);
    assert_eq!(authoritative(&store, &queued.key).io, IoState::Active);
}

#[test]
fn publication_terminal_but_undrained_jobs_keep_their_bounded_slot_and_cannot_be_reclaimed_from_timestamp(
) {
    let (mut store, queued, permit, current) = active();
    let mut invalid = receipt(&queued);
    invalid.body = b"synthetic-sensitive-response-invalid-json".to_vec();
    assert_eq!(
        finish(&mut store, &permit, Some(&current), &[invalid], 1, true, 3),
        Err(Error::InvalidReceipt)
    );
    let failed = assert_unpublished_active_failure(
        &store,
        &queued.key,
        Status::Failed,
        "inventory_rejected",
    );
    let original = begin(
        &mut store,
        &scope(),
        queued.snapshot.as_ref().unwrap(),
        REQUEST,
        u64::MAX,
    )
    .unwrap();
    assert_eq!(
        original, failed,
        "same request cannot restart after a publication failure"
    );
    for index in 2..=MAX_JOBS_PER_SCOPE {
        let request = format!("50000000-0000-4000-8000-{index:012x}");
        begin(
            &mut store,
            &scope(),
            queued.snapshot.as_ref().unwrap(),
            &request,
            u64::MAX,
        )
        .unwrap();
    }
    assert_eq!(store.records.len(), MAX_JOBS_PER_SCOPE);
    assert_eq!(
        begin(
            &mut store,
            &scope(),
            queued.snapshot.as_ref().unwrap(),
            "50000000-0000-4000-8000-999999999999",
            u64::MAX
        ),
        Err(Error::JobLimit)
    );
    assert_eq!(authoritative(&store, &queued.key), failed);
    assert_eq!(store.records.len(), MAX_JOBS_PER_SCOPE);
    assert_eq!(
        public_job(&store, &queued.key, &scope()).unwrap()["cleanupPending"],
        true
    );
}

#[test]
fn foreign_store_scope_request_or_generation_cannot_terminalize_a_current_running_job() {
    for invalid in ["store", "owner", "environment", "request", "generation"] {
        let (mut store, queued, permit, current) = active();
        let before = authoritative(&store, &queued.key);
        let mut forged = WorkerPermit {
            key: permit.key.clone(),
            generation: permit.generation,
            store_identity: permit.store_identity.clone(),
        };
        match invalid {
            "store" => forged.store_identity = Arc::new(()),
            "owner" => forged.key.scope.owner_id = "other-synthetic-owner".into(),
            "environment" => forged.key.scope.environment_id = "other-synthetic-server".into(),
            "request" => forged.key.request_id = "50000000-0000-4000-8000-999999999999".into(),
            _ => forged.generation += 1,
        }
        let mut invalid_receipt = receipt(&queued);
        invalid_receipt.body = b"synthetic-sensitive-response-invalid-json".to_vec();
        assert_eq!(
            finish(
                &mut store,
                &forged,
                Some(&current),
                &[invalid_receipt],
                1,
                true,
                3
            ),
            Err(Error::StaleResult)
        );
        assert_eq!(authoritative(&store, &queued.key), before);
    }
}

#[test]
fn failed_generation_error_replay_cannot_cross_a_new_live_store_identity_or_restart_barrier() {
    let (mut store, queued, permit, current) = active();
    let mut invalid = receipt(&queued);
    invalid.body = b"synthetic-sensitive-response-invalid-json".to_vec();
    assert_eq!(
        finish(&mut store, &permit, Some(&current), &[invalid], 1, true, 3),
        Err(Error::InvalidReceipt)
    );
    let failed = assert_unpublished_active_failure(
        &store,
        &queued.key,
        Status::Failed,
        "inventory_rejected",
    );
    let mut reopened = JobStore {
        records: store.records.clone(),
        ..JobStore::new()
    };
    let valid = receipt(&queued);
    assert_eq!(
        finish(
            &mut reopened,
            &permit,
            Some(&current),
            std::slice::from_ref(&valid),
            1,
            true,
            4
        ),
        Err(Error::StaleResult)
    );
    assert_eq!(authoritative(&reopened, &queued.key), failed);
    // V2 terminal publication preservation before recovery BEGIN
    let prior_outcome = (failed.status, failed.failure, failed.completed_ms);
    // V2 terminal publication preservation before recovery END
    recover_after_restart(&mut store, &scope(), 5).unwrap();
    // V2 terminal publication preservation after recovery BEGIN
    let recovered = authoritative(&store, &queued.key);
    assert_eq!(
        (recovered.status, recovered.failure, recovered.completed_ms),
        prior_outcome,
        "restart cannot overwrite a finalized failure cause or timestamp"
    );
    // V2 terminal publication preservation after recovery END
    // Recovery must invalidate replay as well as publication authority. It must
    // not turn an unresolved failed Active I/O owner into stop evidence.
    assert_eq!(
        finish(&mut store, &permit, Some(&current), &[valid], 1, true, 6),
        Err(Error::StaleResult)
    );
    assert_ne!(authoritative(&store, &queued.key).io, IoState::Quiescent);
    assert_eq!(
        public_job(&store, &queued.key, &scope()).unwrap()["cleanupPending"],
        true
    );
    assert!(authoritative(&store, &queued.key).catalog.is_none());
}

#[test]
fn restart_closes_publication_without_inventing_transport_quiescence_or_starting_a_queued_job() {
    let (mut store, queued, permit, current) = active();
    let second_id = "50000000-0000-4000-8000-000000000002";
    let second = begin(
        &mut store,
        &scope(),
        queued.snapshot.as_ref().unwrap(),
        second_id,
        2,
    )
    .unwrap();
    let mut foreign_profile = profile(ProfileKind::ActualRelay);
    foreign_profile.scope.owner_id = "other-synthetic-owner".into();
    foreign_profile.auth = StoredAuth::Bearer(binding(&foreign_profile));
    let foreign_snapshot = runtime::resolve(
        &foreign_profile.scope,
        &foreign_profile,
        &reference_for(&foreign_profile),
        None,
    )
    .unwrap();
    let foreign = begin(
        &mut store,
        &foreign_profile.scope,
        &foreign_snapshot,
        REQUEST,
        2,
    )
    .unwrap();
    let foreign_worker = dispatch(&mut store, &foreign.key, Some(&foreign_profile)).unwrap();
    let foreign_before = authoritative(&store, &foreign.key);
    recover_after_restart(&mut store, &scope(), 3).unwrap();
    assert_eq!(
        authoritative(&store, &foreign.key),
        foreign_before,
        "scope recovery cannot alter another owner"
    );
    let interrupted = authoritative(&store, &queued.key);
    let never_started = authoritative(&store, &second.key);
    assert_eq!(interrupted.status, Status::Failed);
    assert_eq!(interrupted.completed_ms, Some(3));
    assert_eq!(interrupted.failure, Some(JobFailureReason::ServerRestarted));
    assert!(interrupted.worker_generation.is_none());
    assert_ne!(
        interrupted.io,
        IoState::Quiescent,
        "unknown old boot is not observed stop"
    );
    assert_eq!(never_started.status, Status::Failed);
    assert_eq!(never_started.io, IoState::NeverStarted);
    assert!(never_started.worker_generation.is_none());
    assert_eq!(
        public_job(&store, &queued.key, &scope()).unwrap()["cleanupPending"],
        true
    );
    assert_eq!(
        public_job(&store, &second.key, &scope()).unwrap()["cleanupPending"],
        false
    );
    assert_eq!(
        finish(
            &mut store,
            &permit,
            Some(&current),
            &[receipt(&queued)],
            1,
            true,
            4
        ),
        Err(Error::StaleResult)
    );
    assert_eq!(
        dispatch(&mut store, &second.key, Some(&current)).err(),
        Some(Error::DiscoveryNotRunning)
    );
    assert_eq!(
        finish(
            &mut store,
            &foreign_worker,
            Some(&foreign_profile),
            &[receipt(&foreign)],
            1,
            true,
            4
        )
        .unwrap()
        .status,
        Status::Succeeded
    );
}
