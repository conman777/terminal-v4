use super::{
    config::validate_receipt_binding, ClusterAvailability, DiscoveryPlan, DomainError,
    InventoryKind, InventoryReceipt, ModelCatalog, ModelInfo, ProviderKind, ReasoningControl,
    MAX_MODELS, MAX_MODEL_ID_BYTES, MAX_RESPONSE_BYTES,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub fn normalize_inventory(
    plan: &DiscoveryPlan,
    receipt: &InventoryReceipt,
) -> Result<ModelCatalog, DomainError> {
    validate_receipt_binding(plan, receipt)?;
    match (plan.binding.provider, receipt.kind) {
        (ProviderKind::Actual, InventoryKind::ActualModels)
        | (ProviderKind::LmStudio | ProviderKind::OpenAiCompatible, InventoryKind::OpenAiModels) => {
        }
        _ => return Err(DomainError::ReceiptKindMismatch),
    }
    let document = parse_document(receipt)?;
    let rows = inventory_rows(&document, "data")?;
    let mut seen = HashSet::new();
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        let object = row.as_object().ok_or(DomainError::InvalidInventory)?;
        let id = required_id(object, "id")?;
        let mut model = empty_model_info(id);
        if receipt.kind == InventoryKind::ActualModels {
            if let Some(selector) = optional_id(object, "selector")? {
                model.selection_id = selector.to_owned();
            }
            model.label = optional_label(object, "display_name")?
                .or(optional_label(object, "canonical_name")?)
                .unwrap_or_else(|| id.to_owned());
            let aggregate_loaded = optional_bool(object, "loaded")?;
            model.clusters = actual_clusters(object)?;
            model.loaded = if let Some(selected) = &plan.binding.cluster_id {
                model.clusters.as_ref().and_then(|clusters| {
                    clusters
                        .iter()
                        .find(|cluster| &cluster.cluster_id == selected)
                        .and_then(|cluster| cluster.loaded)
                })
            } else {
                aggregate_loaded
            };
        }
        if !seen.insert(model.selection_id.clone()) {
            return Err(DomainError::DuplicateModelId);
        }
        models.push(model);
    }
    Ok(ModelCatalog {
        binding: plan.binding.clone(),
        models,
    })
}

pub fn enrich_lmstudio(
    catalog: &ModelCatalog,
    plan: &DiscoveryPlan,
    receipt: &InventoryReceipt,
) -> Result<ModelCatalog, DomainError> {
    if catalog.binding != plan.binding {
        return Err(DomainError::ReceiptBindingMismatch);
    }
    validate_receipt_binding(plan, receipt)?;
    if plan.binding.provider != ProviderKind::LmStudio
        || receipt.kind != InventoryKind::LmStudioMetadata
    {
        return Err(DomainError::ReceiptKindMismatch);
    }
    if catalog.models.len() > MAX_MODELS {
        return Err(DomainError::TooManyModels);
    }
    let document = parse_document(receipt)?;
    let rows = inventory_rows(&document, "models")?;
    let native = rows
        .iter()
        .map(parse_native_model)
        .collect::<Result<Vec<_>, _>>()?;
    // Each selector must identify one native record. A key equal to its own loaded
    // instance ID remains a model-key match; multiple instances do not pick a context.
    let mut aliases: HashMap<String, (usize, Option<usize>)> = HashMap::new();
    for (index, model) in native.iter().enumerate() {
        if aliases.insert(model.key.clone(), (index, None)).is_some() {
            return Err(DomainError::DuplicateModelId);
        }
        if let Some(instances) = &model.instances {
            let mut instance_ids = HashSet::new();
            for (instance_index, instance) in instances.iter().enumerate() {
                if !instance_ids.insert(&instance.id) {
                    return Err(DomainError::DuplicateModelId);
                }
                if instance.id == model.key {
                    continue;
                }
                if aliases
                    .insert(instance.id.clone(), (index, Some(instance_index)))
                    .is_some()
                {
                    return Err(DomainError::DuplicateModelId);
                }
            }
        }
    }
    let mut primary_ids = HashSet::new();
    let mut models = Vec::with_capacity(catalog.models.len());
    for primary in &catalog.models {
        validate_id(&primary.selection_id)?;
        if !primary_ids.insert(&primary.selection_id) {
            return Err(DomainError::DuplicateModelId);
        }
        let Some(&(native_index, instance_index)) = aliases.get(&primary.selection_id) else {
            models.push(primary.clone());
            continue;
        };
        let metadata = &native[native_index];
        if !metadata.is_llm {
            continue;
        }
        let mut model = primary.clone();
        if let Some(label) = &metadata.label {
            model.label = label.clone();
        }
        model.loaded = metadata
            .instances
            .as_ref()
            .map(|instances| !instances.is_empty());
        model.image_input = metadata.image_input;
        model.trained_for_tools = metadata.trained_for_tools;
        model.context_window = metadata.context_window;
        model.effective_context = metadata.instances.as_ref().and_then(|instances| {
            if let Some(index) = instance_index {
                instances.get(index).and_then(|instance| instance.context)
            } else if instances.len() == 1 {
                instances[0].context
            } else {
                None
            }
        });
        model.reasoning = metadata.reasoning.clone();
        models.push(model);
    }
    Ok(ModelCatalog {
        binding: catalog.binding.clone(),
        models,
    })
}

fn parse_document(receipt: &InventoryReceipt) -> Result<Value, DomainError> {
    if receipt.body.len() > MAX_RESPONSE_BYTES {
        return Err(DomainError::ResponseTooLarge);
    }
    serde_json::from_slice(&receipt.body).map_err(|_| DomainError::InvalidJson)
}

fn inventory_rows<'a>(document: &'a Value, field: &str) -> Result<&'a Vec<Value>, DomainError> {
    let object = document.as_object().ok_or(DomainError::InvalidInventory)?;
    if object.contains_key("error") {
        return Err(DomainError::InvalidInventory);
    }
    let rows = object
        .get(field)
        .and_then(Value::as_array)
        .ok_or(DomainError::InvalidInventory)?;
    if rows.len() > MAX_MODELS {
        return Err(DomainError::TooManyModels);
    }
    Ok(rows)
}

pub(crate) fn validate_id(id: &str) -> Result<(), DomainError> {
    if id.is_empty()
        || id.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
            != id
        || id.len() > MAX_MODEL_ID_BYTES
        || id.chars().any(char::is_control)
    {
        return Err(DomainError::InvalidModelId);
    }
    Ok(())
}

fn required_id<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str, DomainError> {
    let id = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(DomainError::InvalidModelId)?;
    validate_id(id)?;
    Ok(id)
}

fn optional_id<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, DomainError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let id = value.as_str().ok_or(DomainError::InvalidModelId)?;
            validate_id(id)?;
            Ok(Some(id))
        }
    }
}

fn optional_label(object: &Map<String, Value>, field: &str) -> Result<Option<String>, DomainError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let label = value.as_str().ok_or(DomainError::InvalidCapability)?;
            if label.trim().is_empty() || label.chars().any(char::is_control) {
                return Err(DomainError::InvalidCapability);
            }
            Ok(Some(label.to_owned()))
        }
    }
}

fn optional_bool(object: &Map<String, Value>, field: &str) -> Result<Option<bool>, DomainError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or(DomainError::InvalidCapability),
    }
}

fn optional_context(object: &Map<String, Value>, field: &str) -> Result<Option<u64>, DomainError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .map(Some)
            .ok_or(DomainError::InvalidCapability),
    }
}

fn optional_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a Map<String, Value>>, DomainError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_object()
            .map(Some)
            .ok_or(DomainError::InvalidCapability),
    }
}

fn actual_clusters(
    object: &Map<String, Value>,
) -> Result<Option<Vec<ClusterAvailability>>, DomainError> {
    let rows = match object.get("clusters") {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value.as_array().ok_or(DomainError::InvalidCapability)?,
    };
    if rows.len() > MAX_MODELS {
        return Err(DomainError::InvalidCapability);
    }
    let mut clusters = Vec::with_capacity(rows.len());
    let mut seen = HashSet::new();
    for row in rows {
        let cluster = row.as_object().ok_or(DomainError::InvalidCapability)?;
        let cluster_id =
            required_id(cluster, "cluster_id").map_err(|_| DomainError::InvalidCapability)?;
        if !seen.insert(cluster_id) {
            return Err(DomainError::InvalidCapability);
        }
        clusters.push(ClusterAvailability {
            cluster_id: cluster_id.to_owned(),
            loaded: optional_bool(cluster, "loaded")?,
        });
    }
    Ok(Some(clusters))
}

struct NativeInstance {
    id: String,
    context: Option<u64>,
}

struct NativeModel {
    key: String,
    label: Option<String>,
    is_llm: bool,
    instances: Option<Vec<NativeInstance>>,
    context_window: Option<u64>,
    image_input: Option<bool>,
    trained_for_tools: Option<bool>,
    reasoning: ReasoningControl,
}

fn parse_native_model(value: &Value) -> Result<NativeModel, DomainError> {
    let object = value.as_object().ok_or(DomainError::InvalidInventory)?;
    let is_llm = match object.get("type").and_then(Value::as_str) {
        Some("llm") => true,
        Some("embedding" | "decision") => false,
        _ => return Err(DomainError::InvalidInventory),
    };
    let instances = match object.get("loaded_instances") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let rows = value.as_array().ok_or(DomainError::InvalidCapability)?;
            if rows.len() > MAX_MODELS {
                return Err(DomainError::InvalidCapability);
            }
            let mut instances = Vec::with_capacity(rows.len());
            for row in rows {
                let instance = row.as_object().ok_or(DomainError::InvalidCapability)?;
                let context = optional_object(instance, "config")?
                    .map(|config| optional_context(config, "context_length"))
                    .transpose()?
                    .flatten();
                instances.push(NativeInstance {
                    id: required_id(instance, "id")?.to_owned(),
                    context,
                });
            }
            Some(instances)
        }
    };
    let capabilities = optional_object(object, "capabilities")?;
    let image_input = capabilities
        .map(|value| optional_bool(value, "vision"))
        .transpose()?
        .flatten();
    let trained_for_tools = capabilities
        .map(|value| optional_bool(value, "trained_for_tool_use"))
        .transpose()?
        .flatten();
    let reasoning = match capabilities
        .map(|value| optional_object(value, "reasoning"))
        .transpose()?
        .flatten()
    {
        None => ReasoningControl::Unknown,
        Some(value) => {
            let allowed_rows = value
                .get("allowed_options")
                .and_then(Value::as_array)
                .ok_or(DomainError::InvalidCapability)?;
            if allowed_rows.len() > MAX_MODELS {
                return Err(DomainError::InvalidCapability);
            }
            let mut allowed = Vec::with_capacity(allowed_rows.len());
            let mut seen = HashSet::new();
            for option in allowed_rows {
                let option = option.as_str().ok_or(DomainError::InvalidCapability)?;
                validate_id(option).map_err(|_| DomainError::InvalidCapability)?;
                if !seen.insert(option) {
                    return Err(DomainError::InvalidCapability);
                }
                allowed.push(option.to_owned());
            }
            let default =
                optional_id(value, "default").map_err(|_| DomainError::InvalidCapability)?;
            if default.is_some_and(|default| !allowed.iter().any(|option| option == default)) {
                return Err(DomainError::InvalidCapability);
            }
            ReasoningControl::NativeOptions {
                allowed,
                default: default.map(str::to_owned),
                openai_wire_mapping_verified: false,
            }
        }
    };
    Ok(NativeModel {
        key: required_id(object, "key")?.to_owned(),
        label: optional_label(object, "display_name")?,
        is_llm,
        instances,
        context_window: optional_context(object, "max_context_length")?,
        image_input,
        trained_for_tools,
        reasoning,
    })
}

fn empty_model_info(id: &str) -> ModelInfo {
    ModelInfo {
        selection_id: id.to_owned(),
        public_id: id.to_owned(),
        label: id.to_owned(),
        loaded: None,
        available: None,
        image_input: None,
        trained_for_tools: None,
        context_window: None,
        effective_context: None,
        max_output_tokens: None,
        clusters: None,
        reasoning: ReasoningControl::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        fixtures::*, ClusterAvailability, InventoryKind, ModelInfo, ProviderKind, ReasoningControl,
        MAX_MODELS, MAX_MODEL_ID_BYTES, MAX_RESPONSE_BYTES,
    };
    use super::*;
    use serde_json::json;

    fn catalog(plan: &DiscoveryPlan, models: Vec<ModelInfo>) -> ModelCatalog {
        ModelCatalog {
            binding: plan.binding.clone(),
            models,
        }
    }

    #[test]
    fn actual_minimal_model_keeps_all_unreported_readiness_and_capabilities_unknown() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[{"id":"Gemma 4 12B IT"}]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("Gemma 4 12B IT")]))
        );
    }

    #[test]
    fn actual_selector_is_the_wire_id_while_names_loaded_and_cluster_state_remain_distinct() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[{
                "id":"Gemma 4 12B IT", "selector":"mdl_synthetic", "display_name":"Gemma for project",
                "loaded":true, "clusters":[{"cluster_id":"cluster-loaded","loaded":true},{"cluster_id":"cluster-unloaded","loaded":false},{"cluster_id":"cluster-unknown"}]
            }]}),
        );
        let mut expected = unknown_model("Gemma 4 12B IT");
        expected.selection_id = "mdl_synthetic".into();
        expected.label = "Gemma for project".into();
        expected.loaded = Some(true);
        expected.clusters = Some(vec![
            ClusterAvailability {
                cluster_id: "cluster-loaded".into(),
                loaded: Some(true),
            },
            ClusterAvailability {
                cluster_id: "cluster-unloaded".into(),
                loaded: Some(false),
            },
            ClusterAvailability {
                cluster_id: "cluster-unknown".into(),
                loaded: None,
            },
        ]);
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![expected]))
        );
    }

    #[test]
    fn actual_loaded_elsewhere_does_not_override_false_on_the_selected_cluster() {
        let mut plan = plan(ProviderKind::Actual);
        plan.binding.cluster_id = Some("selected".into());
        plan.requests[0].cluster_id = Some("selected".into());
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[{
                "id":"model-a", "loaded":true,
                "clusters":[{"cluster_id":"other","loaded":true},{"cluster_id":"selected","loaded":false}]
            }]}),
        );
        let mut expected = unknown_model("model-a");
        expected.loaded = Some(false);
        expected.clusters = Some(vec![
            ClusterAvailability {
                cluster_id: "other".into(),
                loaded: Some(true),
            },
            ClusterAvailability {
                cluster_id: "selected".into(),
                loaded: Some(false),
            },
        ]);
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![expected]))
        );
    }

    #[test]
    fn actual_missing_selected_cluster_never_inherits_aggregate_loaded_true() {
        let mut plan = plan(ProviderKind::Actual);
        plan.binding.cluster_id = Some("not-reported".into());
        plan.requests[0].cluster_id = Some("not-reported".into());
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[{"id":"model-a","loaded":true}]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("model-a")]))
        );
    }

    #[test]
    fn generic_openai_listing_only_proves_listing_and_ignores_undocumented_extension_capabilities()
    {
        let plan = plan(ProviderKind::OpenAiCompatible);
        let receipt = receipt(
            &plan,
            InventoryKind::OpenAiModels,
            json!({"data":[{
                "id":"provider/model", "object":"model", "owned_by":"provider",
                "loaded":true, "available":true, "vision":true, "context_length":999999,
                "reasoningLevels":["max"], "url":"https://untrusted.example/inference"
            }]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("provider/model")]))
        );
    }

    #[test]
    fn model_order_is_preserved_without_choosing_a_first_or_default_model() {
        let plan = plan(ProviderKind::OpenAiCompatible);
        let receipt = receipt(
            &plan,
            InventoryKind::OpenAiModels,
            json!({"data":[{"id":"z-model"},{"id":"a-model"}]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(
                &plan,
                vec![unknown_model("z-model"), unknown_model("a-model")]
            ))
        );
    }

    #[test]
    fn empty_inventory_is_successful_empty_data_not_a_synthetic_default_model() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![]))
        );
    }

    #[test]
    fn same_public_name_with_distinct_actual_selectors_is_not_merged() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[
                {"id":"Same model", "selector":"mdl_one"}, {"id":"Same model", "selector":"mdl_two"}
            ]}),
        );
        let mut one = unknown_model("Same model");
        one.selection_id = "mdl_one".into();
        let mut two = unknown_model("Same model");
        two.selection_id = "mdl_two".into();
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![one, two]))
        );
    }

    #[test]
    fn duplicate_wire_ids_reject_the_whole_inventory_instead_of_merging_different_readiness() {
        let plan = plan(ProviderKind::Actual);
        let receipt = receipt(
            &plan,
            InventoryKind::ActualModels,
            json!({"data":[
                {"id":"one", "selector":"duplicate", "loaded":true},
                {"id":"two", "selector":"duplicate", "loaded":false}
            ]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::DuplicateModelId)
        );
    }

    #[test]
    fn blank_control_nonstring_and_oversized_ids_are_rejected_without_truncation() {
        let plan = plan(ProviderKind::OpenAiCompatible);
        for id in [
            json!(""),
            json!("   "),
            json!("model\ncommand"),
            json!(17),
            json!("x".repeat(MAX_MODEL_ID_BYTES + 1)),
        ] {
            let receipt = receipt(
                &plan,
                InventoryKind::OpenAiModels,
                json!({"data":[{"id":id}]}),
            );
            assert_eq!(
                normalize_inventory(&plan, &receipt),
                Err(DomainError::InvalidModelId)
            );
        }
    }

    #[test]
    fn unicode_id_limit_is_utf8_bytes_and_valid_boundary_is_retained_exactly() {
        let plan = plan(ProviderKind::OpenAiCompatible);
        let allowed = "é".repeat(MAX_MODEL_ID_BYTES / 2);
        let receipt = receipt(
            &plan,
            InventoryKind::OpenAiModels,
            json!({"data":[{"id":allowed}]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model(&allowed)]))
        );
        let oversized = super::super::fixtures::receipt(
            &plan,
            InventoryKind::OpenAiModels,
            json!({"data":[{"id":"é".repeat(MAX_MODEL_ID_BYTES/2+1)}]}),
        );
        assert_eq!(
            normalize_inventory(&plan, &oversized),
            Err(DomainError::InvalidModelId)
        );
    }

    #[test]
    fn padded_ids_and_selectors_are_rejected_without_normalization() {
        for provider in [ProviderKind::Actual, ProviderKind::OpenAiCompatible] {
            let plan = plan(provider);
            let kind = plan.requests[0].kind;
            for id in [
                " own-model",
                "own-model ",
                "\u{2003}own-model",
                "\u{feff}own-model",
                "own-model\u{feff}",
            ] {
                let padded_id = receipt(&plan, kind, json!({"data":[{"id":id}]}));
                assert_eq!(
                    normalize_inventory(&plan, &padded_id),
                    Err(DomainError::InvalidModelId)
                );
                if provider == ProviderKind::Actual {
                    let padded_selector = receipt(
                        &plan,
                        kind,
                        json!({"data":[{"id":"own-public-id","selector":id}]}),
                    );
                    assert_eq!(
                        normalize_inventory(&plan, &padded_selector),
                        Err(DomainError::InvalidModelId)
                    );
                }
            }
            let exact = receipt(&plan, kind, json!({"data":[{"id":"own/model id"}]}));
            assert_eq!(
                normalize_inventory(&plan, &exact).unwrap().models[0].selection_id,
                "own/model id"
            );
        }
    }

    #[test]
    fn malformed_known_actual_boolean_and_cluster_fields_do_not_become_false_or_unknown() {
        let plan = plan(ProviderKind::Actual);
        for payload in [
            json!({"data":[{"id":"model","loaded":"yes"}]}),
            json!({"data":[{"id":"model","clusters":"cluster"}]}),
            json!({"data":[{"id":"model","clusters":[{"cluster_id":"cluster","loaded":0}]}]}),
        ] {
            let receipt = receipt(&plan, InventoryKind::ActualModels, payload);
            assert_eq!(
                normalize_inventory(&plan, &receipt),
                Err(DomainError::InvalidCapability)
            );
        }
    }

    #[test]
    fn json_errors_wrong_shapes_and_provider_error_envelopes_are_distinct_from_empty_inventory() {
        let plan = plan(ProviderKind::OpenAiCompatible);
        let mut receipt = receipt(&plan, InventoryKind::OpenAiModels, json!({"data":[]}));
        receipt.body = b"<html>untrusted error</html>".to_vec();
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::InvalidJson)
        );
        for body in [
            json!([]),
            json!({}),
            json!({"data":{}}),
            json!({"data":[null]}),
            json!({"error":{"message":"private detail"},"data":[]}),
        ] {
            receipt.body = serde_json::to_vec(&body).unwrap();
            assert_eq!(
                normalize_inventory(&plan, &receipt),
                Err(DomainError::InvalidInventory)
            );
        }
    }

    #[test]
    fn body_and_model_count_bounds_fail_without_partial_results() {
        let plan = plan(ProviderKind::OpenAiCompatible);
        let mut receipt = receipt(&plan, InventoryKind::OpenAiModels, json!({"data":[]}));
        receipt.body = vec![b' '; MAX_RESPONSE_BYTES + 1];
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::ResponseTooLarge)
        );
        receipt.body = serde_json::to_vec(&json!({"data":(0..=MAX_MODELS).map(|index|json!({"id":format!("model-{index}")})).collect::<Vec<_>>()})).unwrap();
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::TooManyModels)
        );
    }

    #[test]
    fn cross_endpoint_or_credential_revision_result_is_rejected_before_body_parsing() {
        let plan = plan(ProviderKind::Actual);
        let mut receipt = receipt(&plan, InventoryKind::ActualModels, json!({"data":[]}));
        receipt.body = b"not JSON and must not be parsed for another credential".to_vec();
        receipt.binding.credential_generation = Some("credential-2".into());
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::ReceiptBindingMismatch)
        );
        receipt.binding = plan.binding.clone();
        receipt.effective_url = "https://different.example.test/v1/models".into();
        assert_eq!(
            normalize_inventory(&plan, &receipt),
            Err(DomainError::ReceiptTargetMismatch)
        );
    }

    #[test]
    fn lmstudio_metadata_enriches_exact_ids_and_retains_native_reasoning_without_inventing_wire_mapping(
    ) {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model-a")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[{
                "type":"llm", "key":"model-a", "display_name":"Local model A",
                "loaded_instances":[{"id":"model-a","config":{"context_length":4096}}],
                "max_context_length":131072,
                "capabilities":{"vision":true,"trained_for_tool_use":false,
                                "reasoning":{"allowed_options":["off","on"],"default":"on"}}
            }]}),
        );
        let mut expected = unknown_model("model-a");
        expected.label = "Local model A".into();
        expected.loaded = Some(true);
        expected.image_input = Some(true);
        expected.trained_for_tools = Some(false);
        expected.context_window = Some(131072);
        expected.effective_context = Some(4096);
        expected.reasoning = ReasoningControl::NativeOptions {
            allowed: vec!["off".into(), "on".into()],
            default: Some("on".into()),
            openai_wire_mapping_verified: false,
        };
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![expected]))
        );
    }

    #[test]
    fn lmstudio_unloaded_jit_listing_is_not_declared_unavailable_and_missing_state_stays_unknown() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(
            &plan,
            vec![unknown_model("unloaded"), unknown_model("unknown")],
        );
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[
                {"type":"llm","key":"unloaded","loaded_instances":[]},
                {"type":"llm","key":"unknown"}
            ]}),
        );
        let mut unloaded = unknown_model("unloaded");
        unloaded.loaded = Some(false);
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![unloaded, unknown_model("unknown")]))
        );
    }

    #[test]
    fn lmstudio_native_embedding_and_decision_entries_are_removed_only_on_exact_primary_match() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(
            &plan,
            vec![
                unknown_model("llm"),
                unknown_model("embed"),
                unknown_model("decision"),
            ],
        );
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[
                {"type":"llm","key":"llm"},{"type":"embedding","key":"embed"},{"type":"decision","key":"decision"},
                {"type":"llm","key":"native-only-not-in-openai-list"}
            ]}),
        );
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("llm")]))
        );
    }

    #[test]
    fn multiple_loaded_lmstudio_instances_do_not_invent_one_effective_context_for_a_model_key() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model-key")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[{
                "type":"llm","key":"model-key","max_context_length":131072,
                "loaded_instances":[{"id":"instance-one","config":{"context_length":4096}},
                                    {"id":"instance-two","config":{"context_length":8192}}]
            }]}),
        );
        let mut expected = unknown_model("model-key");
        expected.loaded = Some(true);
        expected.context_window = Some(131072);
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![expected]))
        );
    }

    #[test]
    fn native_capabilities_validate_types_and_reasoning_default_membership() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        for extra in [
            json!({"max_context_length":-1}),
            json!({"max_context_length":3.5}),
            json!({"capabilities":{"vision":"yes"}}),
            json!({"capabilities":{"reasoning":{"allowed_options":["off","on"],"default":"max"}}}),
        ] {
            let mut item = json!({"type":"llm","key":"model"});
            for (key, value) in extra.as_object().unwrap() {
                item[key] = value.clone();
            }
            let receipt = receipt(
                &plan,
                InventoryKind::LmStudioMetadata,
                json!({"models":[item]}),
            );
            assert_eq!(
                enrich_lmstudio(&primary, &plan, &receipt),
                Err(DomainError::InvalidCapability)
            );
        }
    }

    #[test]
    fn failed_metadata_never_mutates_existing_primary_inventory_or_changes_its_binding() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("saved-custom-model")]);
        let before = primary.clone();
        let mut receipt = receipt(&plan, InventoryKind::LmStudioMetadata, json!({"models":[]}));
        receipt.binding.config_revision = "config-new".into();
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::ReceiptBindingMismatch)
        );
        assert_eq!(primary, before);
    }

    #[test]
    fn malformed_metadata_shape_is_not_treated_as_a_successful_empty_model_list() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        for payload in [json!({}), json!({"models":{}}), json!({"models":[null]})] {
            let receipt = receipt(&plan, InventoryKind::LmStudioMetadata, payload);
            assert_eq!(
                enrich_lmstudio(&primary, &plan, &receipt),
                Err(DomainError::InvalidInventory)
            );
        }
    }

    #[test]
    fn duplicated_native_metadata_id_cannot_overwrite_an_earlier_capability_record() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[
                {"type":"llm","key":"model","capabilities":{"vision":false}},
                {"type":"llm","key":"model","capabilities":{"vision":true}}
            ]}),
        );
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::DuplicateModelId)
        );
    }

    #[test]
    fn metadata_is_not_reused_for_a_different_primary_catalog_binding() {
        let plan = plan(ProviderKind::LmStudio);
        let mut primary = catalog(&plan, vec![unknown_model("model")]);
        primary.binding.environment_id = "other-server".into();
        let receipt = receipt(&plan, InventoryKind::LmStudioMetadata, json!({"models":[]}));
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::ReceiptBindingMismatch)
        );
    }

    #[test]
    fn optional_null_capabilities_do_not_turn_into_false_zero_or_unsupported_reasoning() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[{
                "type":"llm","key":"model","max_context_length":null,"capabilities":null
            }]}),
        );
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("model")]))
        );
    }

    #[test]
    fn metadata_cannot_trigger_followup_urls_or_model_loading_through_unknown_fields() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[{
                "type":"llm","key":"model","next":"http://127.0.0.1:9999/secrets",
                "load":{"method":"POST","url":"/api/v1/models/load"},"reasoning_effort":"max"
            }]}),
        );
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![unknown_model("model")]))
        );
    }

    #[test]
    fn exact_loaded_instance_id_keeps_its_primary_wire_id_and_gets_only_its_own_context() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("instance-two")]);
        let receipt = receipt(
            &plan,
            InventoryKind::LmStudioMetadata,
            json!({"models":[{
                "type":"llm","key":"native-model-key","max_context_length":131072,
                "loaded_instances":[{"id":"instance-one","config":{"context_length":4096}},
                                    {"id":"instance-two","config":{"context_length":8192}}]
            }]}),
        );
        let mut expected = unknown_model("instance-two");
        expected.loaded = Some(true);
        expected.context_window = Some(131072);
        expected.effective_context = Some(8192);
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Ok(catalog(&plan, vec![expected]))
        );
    }

    #[test]
    fn colliding_native_keys_and_instance_ids_are_rejected_without_arbitrary_matching() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("collision")]);
        for rows in [
            json!([
                {"type":"llm","key":"one","loaded_instances":[{"id":"collision"}]},
                {"type":"llm","key":"collision"}
            ]),
            json!([
                {"type":"llm","key":"collision"},
                {"type":"llm","key":"one","loaded_instances":[{"id":"collision"}]}
            ]),
            json!([
                {"type":"llm","key":"one","loaded_instances":[{"id":"collision"},{"id":"collision"}]}
            ]),
        ] {
            let receipt = receipt(
                &plan,
                InventoryKind::LmStudioMetadata,
                json!({"models":rows}),
            );
            assert_eq!(
                enrich_lmstudio(&primary, &plan, &receipt),
                Err(DomainError::DuplicateModelId)
            );
        }
    }

    #[test]
    fn optional_metadata_enforces_json_error_and_body_bounds_without_changing_primary_data() {
        let plan = plan(ProviderKind::LmStudio);
        let primary = catalog(&plan, vec![unknown_model("model")]);
        let before = primary.clone();
        let mut receipt = receipt(&plan, InventoryKind::LmStudioMetadata, json!({"models":[]}));
        receipt.body = b"malformed metadata".to_vec();
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::InvalidJson)
        );
        receipt.body =
            serde_json::to_vec(&json!({"error":{"message":"provider detail"},"models":[]}))
                .unwrap();
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::InvalidInventory)
        );
        receipt.body = vec![b' '; MAX_RESPONSE_BYTES + 1];
        assert_eq!(
            enrich_lmstudio(&primary, &plan, &receipt),
            Err(DomainError::ResponseTooLarge)
        );
        assert_eq!(primary, before);
    }
}
