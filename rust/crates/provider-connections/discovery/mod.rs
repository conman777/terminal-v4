pub mod config;
pub mod normalize;

pub const MAX_RESPONSE_BYTES: usize = 2_000_000;
pub const MAX_MODELS: usize = 1_000;
pub const MAX_MODEL_ID_BYTES: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainError {
    NotImplemented,
    InvalidEndpoint,
    InvalidProfile,
    UnsupportedProviderMode,
    NoAuthRequiresLoopback,
    MissingCredential,
    UnexpectedCredential,
    InvalidCredential,
    CredentialTargetMismatch,
    ReceiptBindingMismatch,
    ReceiptTargetMismatch,
    ReceiptKindMismatch,
    InvalidJson,
    InvalidInventory,
    InvalidModelId,
    DuplicateModelId,
    InvalidCapability,
    ResponseTooLarge,
    TooManyModels,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    Actual,
    LmStudio,
    OpenAiCompatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionMode {
    Relay,
    Local,
    CustomHttps,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    None,
    ApiKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialReference {
    pub vault_id: String,
    pub generation: String,
    pub bound_base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Authentication {
    None,
    ApiKey(CredentialReference),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub base_url: String,
    pub verified_literal_loopback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub owner_id: String,
    pub environment_id: String,
    pub profile_id: String,
    pub config_revision: String,
    pub provider: ProviderKind,
    pub mode: ConnectionMode,
    pub base_url: String,
    pub authentication: Authentication,
    pub cluster_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryBinding {
    pub owner_id: String,
    pub environment_id: String,
    pub profile_id: String,
    pub config_revision: String,
    pub provider: ProviderKind,
    pub base_url: String,
    pub auth_mode: AuthMode,
    pub credential_id: Option<String>,
    pub credential_generation: Option<String>,
    pub cluster_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryKind {
    ActualModels,
    OpenAiModels,
    LmStudioMetadata,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryMethod {
    Get,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryRequest {
    pub method: InventoryMethod,
    pub kind: InventoryKind,
    pub url: String,
    pub credential: Option<CredentialReference>,
    pub cluster_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryPlan {
    pub binding: DiscoveryBinding,
    pub requests: Vec<InventoryRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryReceipt {
    pub binding: DiscoveryBinding,
    pub kind: InventoryKind,
    pub effective_url: String,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClusterAvailability {
    pub cluster_id: String,
    pub loaded: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReasoningControl {
    Unknown,
    NativeOptions {
        allowed: Vec<String>,
        default: Option<String>,
        openai_wire_mapping_verified: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub selection_id: String,
    pub public_id: String,
    pub label: String,
    pub loaded: Option<bool>,
    pub available: Option<bool>,
    pub image_input: Option<bool>,
    pub trained_for_tools: Option<bool>,
    pub context_window: Option<u64>,
    pub effective_context: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub clusters: Option<Vec<ClusterAvailability>>,
    pub reasoning: ReasoningControl,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCatalog {
    pub binding: DiscoveryBinding,
    pub models: Vec<ModelInfo>,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use serde_json::Value;

    pub fn profile(provider: ProviderKind) -> Profile {
        let actual = provider == ProviderKind::Actual;
        Profile {
            owner_id: "synthetic-owner".into(),
            environment_id: "synthetic-server".into(),
            profile_id: "synthetic-profile".into(),
            config_revision: "config-1".into(),
            provider,
            mode: if actual {
                ConnectionMode::Relay
            } else {
                ConnectionMode::Local
            },
            base_url: if actual {
                "https://api.actual.inc/v1"
            } else {
                "http://127.0.0.1:1234/v1"
            }
            .into(),
            authentication: if actual {
                Authentication::ApiKey(CredentialReference {
                    vault_id: "synthetic-vault-reference".into(),
                    generation: "credential-1".into(),
                    bound_base_url: "https://api.actual.inc/v1".into(),
                })
            } else {
                Authentication::None
            },
            cluster_id: None,
        }
    }

    pub fn plan(provider: ProviderKind) -> DiscoveryPlan {
        let profile = profile(provider);
        let credential = match &profile.authentication {
            Authentication::None => None,
            Authentication::ApiKey(reference) => Some(reference.clone()),
        };
        let binding = DiscoveryBinding {
            owner_id: profile.owner_id,
            environment_id: profile.environment_id,
            profile_id: profile.profile_id,
            config_revision: profile.config_revision,
            provider,
            base_url: profile.base_url.clone(),
            auth_mode: if credential.is_some() {
                AuthMode::ApiKey
            } else {
                AuthMode::None
            },
            credential_id: credential.as_ref().map(|value| value.vault_id.clone()),
            credential_generation: credential.as_ref().map(|value| value.generation.clone()),
            cluster_id: None,
        };
        let mut requests = vec![InventoryRequest {
            method: InventoryMethod::Get,
            kind: if provider == ProviderKind::Actual {
                InventoryKind::ActualModels
            } else {
                InventoryKind::OpenAiModels
            },
            url: format!("{}/models", profile.base_url),
            credential,
            cluster_id: None,
        }];
        if provider == ProviderKind::LmStudio {
            requests.push(InventoryRequest {
                method: InventoryMethod::Get,
                kind: InventoryKind::LmStudioMetadata,
                url: "http://127.0.0.1:1234/api/v1/models".into(),
                credential: None,
                cluster_id: None,
            });
        }
        DiscoveryPlan { binding, requests }
    }

    pub fn receipt(plan: &DiscoveryPlan, kind: InventoryKind, body: Value) -> InventoryReceipt {
        InventoryReceipt {
            binding: plan.binding.clone(),
            kind,
            effective_url: plan
                .requests
                .iter()
                .find(|request| request.kind == kind)
                .unwrap()
                .url
                .clone(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    pub fn unknown_model(id: &str) -> ModelInfo {
        ModelInfo {
            selection_id: id.into(),
            public_id: id.into(),
            label: id.into(),
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
}
