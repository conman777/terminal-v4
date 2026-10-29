use super::*;
use crate::fixtures::*;
use serde_json::json;

#[test]
fn plans_keep_the_exact_api_prefix_transport_model_and_cluster_binding() {
    for (kind, suffix, transport) in [
        (
            ProfileKind::ActualLocal,
            "responses",
            Transport::OpenAiResponses,
        ),
        (
            ProfileKind::ActualRelay,
            "responses",
            Transport::OpenAiResponses,
        ),
        (
            ProfileKind::LmStudioLocal,
            "chat/completions",
            Transport::OpenAiChat,
        ),
    ] {
        let mut snapshot = effective(kind);
        if kind != ProfileKind::ActualRelay {
            snapshot.base_url = "http://127.3.4.5:43210/prefix/v1".into();
            if let StoredAuth::Bearer(ref mut binding) = snapshot.auth {
                binding.target.base_url = snapshot.base_url.clone();
            }
        }
        let plan = InferencePlan::prepare(&snapshot, "org/model:quant").unwrap();
        assert_eq!(
            plan.request_url(),
            format!("{}/{suffix}", snapshot.base_url)
        );
        assert_eq!(plan.model(), "org/model:quant");
        assert_eq!(plan.transport(), transport);
        assert_eq!(plan.snapshot, snapshot);
    }
}

#[test]
fn invalid_models_and_constructed_snapshot_mismatches_are_rejected() {
    let snapshot = effective(ProfileKind::ActualLocal);
    for model in [
        "",
        " ",
        " leading",
        "trailing ",
        "bad\nmodel",
        &"m".repeat(201),
    ] {
        assert_eq!(
            InferencePlan::prepare(&snapshot, model),
            Err(Error::InvalidInput)
        );
    }
    for field in ["revision", "transport", "endpoint", "credential", "scope"] {
        let mut changed = snapshot.clone();
        match field {
            "revision" => changed.reference.revision = uuid::Uuid::nil().to_string(),
            "transport" => changed.transport = Transport::OpenAiChat,
            "endpoint" => changed.base_url = "http://remote.invalid/v1".into(),
            "credential" => changed.reference.credential_id = Some(NEXT_CREDENTIAL.into()),
            _ => changed.reference.scope.owner_id = "".into(),
        }
        assert!(
            InferencePlan::prepare(&changed, "model").is_err(),
            "{field}"
        );
    }
}

#[test]
fn padded_models_include_browser_trimmed_unicode_edges_without_changing_internal_unicode() {
    let snapshot = effective(ProfileKind::ActualLocal);
    for model in [
        "\u{feff}own-model",
        "own-model\u{feff}",
        "\u{2003}own-model",
    ] {
        assert_eq!(
            InferencePlan::prepare(&snapshot, model),
            Err(Error::InvalidInput)
        );
    }
    assert_eq!(
        InferencePlan::prepare(&snapshot, "own\u{feff}model")
            .unwrap()
            .model(),
        "own\u{feff}model"
    );
}

#[test]
fn request_encoding_never_changes_the_selected_model_or_mutates_the_input() {
    let plan = InferencePlan::prepare(&effective(ProfileKind::LmStudioLocal), "selected").unwrap();
    let body = json!({"model":"selected","messages":[{"role":"user","content":"hello"}],"stream":false,"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]});
    let mut expected = body.clone();
    expected["stream"] = json!(true);
    assert_eq!(
        serde_json::from_slice::<Value>(&plan.encode_request(&body).unwrap()).unwrap(),
        expected
    );
    assert_eq!(body["stream"], false);
    for changed in [
        json!({}),
        json!({"model":"other"}),
        json!({"model":null}),
        json!([]),
    ] {
        assert_eq!(plan.encode_request(&changed), Err(Error::InvalidInput));
    }
}

#[test]
fn request_encoding_bounds_bytes_and_rejects_route_or_credential_overrides() {
    let plan = InferencePlan::prepare(&effective(ProfileKind::ActualLocal), "selected").unwrap();
    for key in ["headers", "api_key", "base_url", "url", "extra_headers"] {
        let mut body = json!({"model":"selected","input":"hi"});
        body[key] = json!("untrusted");
        assert_eq!(
            plan.encode_request(&body),
            Err(Error::InvalidInput),
            "{key}"
        );
    }
    assert_eq!(
        plan.encode_request(&json!({"model":"selected","input":"x".repeat(24_000_000)})),
        Err(Error::CapacityReached)
    );
}
