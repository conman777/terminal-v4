use super::*;
use crate::fixtures::*;
fn running() -> (JobStore, WorkerPermit, StoredProfile) {
    let mut store = JobStore::new();
    let profile = profile(ProfileKind::ActualLocal);
    let snapshot = runtime::resolve(&scope(), &profile, &reference(&profile), None).unwrap();
    let job = begin(&mut store, &scope(), &snapshot, REQUEST, 10).unwrap();
    let permit = dispatch(&mut store, &job.key, Some(&profile)).unwrap();
    (store, permit, profile)
}
fn succeeded() -> JobStore {
    let (mut store, permit, profile) = running();
    let plan = runtime::discovery_plan(store.records[0].snapshot.as_ref().unwrap()).unwrap();
    let receipt = discovery::InventoryReceipt {
        binding: plan.binding.clone(),
        kind: plan.requests[0].kind,
        effective_url: plan.requests[0].url.clone(),
        body: br#"{"data":[{"id":"own-checkpoint-model"}]}"#.to_vec(),
    };
    finish(&mut store, &permit, Some(&profile), &[receipt], 1, true, 20).unwrap();
    store
}
#[test]
fn completed_history_roundtrips_unknown_capabilities_without_live_authority() {
    let original = succeeded();
    let raw = encode(&original, &scope()).unwrap();
    let loaded = decode_after_restart(&raw, &scope(), 99).unwrap();
    assert_eq!(
        public_job(&loaded, &loaded.records[0].key, &scope()).unwrap(),
        public_job(&original, &original.records[0].key, &scope()).unwrap()
    );
    assert!(!Arc::ptr_eq(&original.identity, &loaded.identity));
    assert!(loaded.pending_io.is_empty());
    assert!(loaded.closed_failures.is_empty());
    assert!(loaded.records[0].worker_generation.is_none());
    assert!(loaded.records[0].catalog.as_ref().unwrap().models[0]
        .image_input
        .is_none());
    assert!(
        !loaded.records[0]
            .receipt
            .as_ref()
            .unwrap()
            .inference_verified
    );
}
#[test]
fn interrupted_history_fails_unconfirmed_and_rejects_the_original_permit() {
    let (original, permit, profile) = running();
    let mut loaded =
        decode_after_restart(&encode(&original, &scope()).unwrap(), &scope(), 99).unwrap();
    let job = public_job(&loaded, &loaded.records[0].key, &scope()).unwrap();
    assert_eq!(job["status"], "failed");
    assert_eq!(job["error"]["code"], "server_restarted");
    assert_eq!(job["cleanupPending"], true);
    assert_eq!(job["cancelConfirmed"], false);
    assert!(job["models"].is_null());
    assert_eq!(
        finish(&mut loaded, &permit, Some(&profile), &[], 0, true, 100),
        Err(Error::StaleResult)
    );
}
#[test]
fn cancelled_tombstone_survives_restart_and_prevents_late_begin() {
    let mut store = JobStore::new();
    let key = JobKey {
        scope: scope(),
        profile_id: PROFILE.into(),
        request_id: REQUEST.into(),
    };
    cancel(&mut store, &key, 1).unwrap();
    let mut loaded =
        decode_after_restart(&encode(&store, &scope()).unwrap(), &scope(), 99).unwrap();
    let job = begin(
        &mut loaded,
        &scope(),
        &effective(ProfileKind::ActualLocal),
        REQUEST,
        100,
    )
    .unwrap();
    assert_eq!(job.status, Status::Cancelled);
    assert!(job.snapshot.is_none());
    assert_eq!(loaded.records.len(), 1);
}
#[test]
fn native_metadata_roundtrips_without_claiming_a_wire_reasoning_mapping() {
    let mut store = succeeded();
    let model = &mut store.records[0].catalog.as_mut().unwrap().models[0];
    model.loaded = Some(false);
    model.image_input = Some(true);
    model.context_window = Some(8192);
    model.reasoning = discovery::ReasoningControl::NativeOptions {
        allowed: vec!["disabled".into(), "enabled".into()],
        default: Some("disabled".into()),
        openai_wire_mapping_verified: false,
    };
    let loaded = decode_after_restart(&encode(&store, &scope()).unwrap(), &scope(), 99).unwrap();
    assert_eq!(loaded.records[0].catalog, store.records[0].catalog);
}
#[test]
fn scope_unknown_fields_duplicate_requests_and_forged_inference_flags_are_rejected() {
    let raw = encode(&succeeded(), &scope()).unwrap();
    let original: Value = serde_json::from_slice(&raw).unwrap();
    for mutation in 0..4 {
        let mut value = original.clone();
        match mutation {
            0 => value["owner"] = json!("other-owner"),
            1 => value["records"][0]["worker_permit"] = json!("forged"),
            2 => {
                let duplicate = value["records"][0].clone();
                value["records"].as_array_mut().unwrap().push(duplicate);
            }
            3 => value["records"][0]["receipt"]["inference_verified"] = json!(true),
            _ => unreachable!(),
        }
        assert!(decode_after_restart(&serde_json::to_vec(&value).unwrap(), &scope(), 99).is_err());
    }
    assert!(decode_after_restart(
        &raw,
        &Scope {
            owner_id: "other-owner".into(),
            environment_id: scope().environment_id
        },
        99
    )
    .is_err());
}
#[test]
fn malformed_catalogs_and_impossible_terminal_states_fail_closed() {
    let raw = encode(&succeeded(), &scope()).unwrap();
    let original: Value = serde_json::from_slice(&raw).unwrap();
    for mutation in 0..4 {
        let mut value = original.clone();
        match mutation {
            0 => value["records"][0]["models"][0]["context_window"] = json!(0),
            1 => value["records"][0]["receipt"]["models"] = json!(2),
            2 => value["records"][0]["io"] = json!("active"),
            3 => value["records"][0]["snapshot"] = Value::Null,
            _ => unreachable!(),
        }
        assert!(decode_after_restart(&serde_json::to_vec(&value).unwrap(), &scope(), 99).is_err());
    }
}
#[test]
fn checkpoint_size_and_record_count_are_bounded() {
    assert!(decode_after_restart(&vec![b' '; MAX_CHECKPOINT_BYTES + 1], &scope(), 99).is_err());
    let mut store = JobStore::new();
    for index in 0..MAX_JOBS_PER_SCOPE {
        let key = JobKey {
            scope: scope(),
            profile_id: PROFILE.into(),
            request_id: format!("50000000-0000-4000-8000-{index:012x}"),
        };
        cancel(&mut store, &key, 1).unwrap();
    }
    let raw = encode(&store, &scope()).unwrap();
    assert_eq!(
        decode_after_restart(&raw, &scope(), 99)
            .unwrap()
            .records
            .len(),
        MAX_JOBS_PER_SCOPE
    );
    let mut value: Value = serde_json::from_slice(&raw).unwrap();
    let extra = value["records"][0].clone();
    value["records"].as_array_mut().unwrap().push(extra);
    assert!(decode_after_restart(&serde_json::to_vec(&value).unwrap(), &scope(), 99).is_err());
}
#[test]
fn encoding_rejects_cross_scope_records_and_mismatched_catalog_binding() {
    let mut store = succeeded();
    store.records[0].key.scope.owner_id = "other-owner".into();
    assert_eq!(encode(&store, &scope()), Err(Error::InvalidScope));
    let mut store = succeeded();
    store.records[0]
        .catalog
        .as_mut()
        .unwrap()
        .binding
        .config_revision = NEXT_REVISION.into();
    assert!(encode(&store, &scope()).is_err());
}

#[test]
fn wall_clock_moving_backwards_does_not_invalidate_a_completed_record() {
    let mut store = succeeded();
    store.records[0].completed_ms = Some(1);
    let loaded = decode_after_restart(&encode(&store, &scope()).unwrap(), &scope(), 99).unwrap();
    assert_eq!(loaded.records[0].completed_ms, Some(1));
}
