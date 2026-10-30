use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Selection {
    pub(crate) transport: String,
    pub(crate) base_url: String,
    pub(crate) base_url_env_key: Option<String>,
    pub(crate) reasoning_levels: Vec<String>,
    pub(crate) thinking_on_reasoning: Option<Value>,
    pub(crate) image_input: Option<bool>,
    pub(crate) output_tokens: u64,
    pub(crate) encrypted_response_state: bool,
}

pub(crate) fn definition(provider: &str) -> Option<&'static Value> {
    static DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();
    DEFINITIONS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../agent_provider_definitions.json"))
                .expect("checked provider metadata")
        })
        .iter()
        .find(|entry| entry["id"] == provider)
}

pub(crate) fn select(provider: &str, model: &str) -> Result<Selection, String> {
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Invalid model".into());
    }
    #[cfg(unix)]
    if let Some(binding) = super::profile::Binding::parse(provider) {
        return Ok(Selection {
            transport: binding.protocol().into(),
            base_url: String::new(),
            base_url_env_key: None,
            reasoning_levels: vec![],
            thinking_on_reasoning: None,
            image_input: Some(false),
            output_tokens: 8192,
            encrypted_response_state: false,
        });
    }
    let definition = definition(provider).ok_or("Unknown provider")?;
    if definition["auth"] != "api-key" {
        return Err("This provider needs an additional V4 adapter".into());
    }
    let selected = definition["models"]
        .as_array()
        .and_then(|models| models.iter().find(|entry| entry["id"] == model));
    let option = |key: &str| {
        selected
            .and_then(|entry| entry.get(key))
            .or_else(|| definition.get(key))
    };
    let transport = option("transport")
        .and_then(Value::as_str)
        .ok_or("Missing provider transport")?;
    if !matches!(
        transport,
        "openai-chat" | "openai-responses" | "anthropic-messages"
    ) {
        return Err("This provider needs an additional V4 adapter".into());
    }
    let levels = selected
        .and_then(|entry| entry["reasoningLevels"].as_array())
        .map(|levels| {
            levels
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(Selection {
        transport: transport.into(),
        base_url: option("baseUrl")
            .and_then(Value::as_str)
            .ok_or("Provider endpoint is required")?
            .into(),
        base_url_env_key: option("baseUrlEnvKey")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reasoning_levels: levels,
        thinking_on_reasoning: selected
            .and_then(|entry| entry.get("thinkingOnReasoning"))
            .cloned(),
        image_input: selected.and_then(|entry| entry["imageInput"].as_bool()),
        output_tokens: selected
            .and_then(|entry| entry["maxOutputTokens"].as_u64())
            .unwrap_or(8192)
            .clamp(1, 8192),
        encrypted_response_state: definition["supportsEncryptedResponseState"] == true,
    })
}

pub(crate) fn model_reasoning_levels(provider: &str, model: &str) -> Value {
    json!(select(provider, model)
        .map(|selection| selection.reasoning_levels)
        .unwrap_or_default())
}

pub(crate) fn reasoning_levels(provider: &str) -> Value {
    let levels = definition(provider)
        .and_then(|entry| entry["models"].as_array())
        .into_iter()
        .flatten()
        .flat_map(|model| model["reasoningLevels"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    json!(["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .filter(|level| levels.contains(level))
        .collect::<Vec<_>>())
}

pub(crate) fn catalog_models(provider: &str) -> Value {
    let mut models = definition(provider)
        .and_then(|entry| entry["models"].as_array())
        .cloned()
        .unwrap_or_default();
    for model in &mut models {
        model["reasoningLevels"] =
            model_reasoning_levels(provider, model["id"].as_str().unwrap_or(""));
    }
    json!(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_capabilities_follow_the_exact_selected_model() {
        assert_eq!(
            select("openai-api", "gpt-5.4").unwrap().reasoning_levels,
            ["none", "low", "medium", "high", "xhigh"]
        );
        assert!(select("openai-api", "gpt-4.1")
            .unwrap()
            .reasoning_levels
            .is_empty());
        assert_eq!(
            select("anthropic-api", "claude-fable-5")
                .unwrap()
                .reasoning_levels,
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(
            select("anthropic-api", "claude-opus-4-6")
                .unwrap()
                .reasoning_levels,
            ["low", "medium", "high", "max"]
        );
        assert!(select("anthropic-api", "custom-unverified-model")
            .unwrap()
            .reasoning_levels
            .is_empty());
    }

    #[test]
    fn one_provider_can_route_models_to_their_actual_protocol_and_endpoint() {
        let minimax = select("opencode-go", "minimax-m3").unwrap();
        assert_eq!(minimax.transport, "anthropic-messages");
        assert_eq!(
            minimax.base_url,
            "https://opencode.ai/inference/go/anthropic"
        );
        assert_eq!(
            minimax.base_url_env_key.as_deref(),
            Some("OPENCODE_GO_ANTHROPIC_BASE_URL")
        );
        let kimi = select("opencode-go", "kimi-k3").unwrap();
        assert_eq!(kimi.transport, "openai-chat");
        assert_eq!(kimi.base_url, "https://opencode.ai/inference/go/openai/v1");
        assert!(kimi.reasoning_levels.is_empty());
    }

    #[test]
    fn invalid_or_unsupported_selections_fail_without_synthesizing_capabilities() {
        assert!(select("missing", "model").is_err());
        assert!(select("copilot", "model").is_err());
        assert!(select("openai-api", "bad\nmodel").is_err());
        assert!(select("openai-api", "").is_err());
        let custom = select("deepseek", "custom-model").unwrap();
        assert_eq!(custom.transport, "openai-chat");
        assert!(custom.reasoning_levels.is_empty());
    }

    #[test]
    fn catalog_metadata_preserves_exact_empty_levels_and_known_union() {
        let models = catalog_models("openai-api");
        assert_eq!(
            models[0]["reasoningLevels"],
            json!(["none", "low", "medium", "high", "xhigh"])
        );
        assert_eq!(models[1]["reasoningLevels"], json!([]));
        assert_eq!(
            reasoning_levels("anthropic-api"),
            json!(["low", "medium", "high", "xhigh", "max"])
        );
        assert_eq!(model_reasoning_levels("openai-api", "unknown"), json!([]));
    }
}
