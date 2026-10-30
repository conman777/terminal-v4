use regex_lite::Regex;
use serde_json::{json, Map, Value};
use url::{Host, Url};

pub(crate) type Settings = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Azure,
    Bedrock,
    Vertex,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub(crate) url: String,
    pub(crate) api_key_header: Option<String>,
    pub(crate) bearer: Option<String>,
}

const AZURE_SUFFIXES: &[&str] = &[
    ".openai.azure.com",
    ".services.ai.azure.com",
    ".cognitiveservices.azure.com",
    ".openai.azure.us",
    ".cognitiveservices.azure.us",
    ".openai.azure.cn",
];
const LOOPBACK_ENV: &str = "TERMINAL_V4_CLOUD_PROVIDER_ALLOW_LOOPBACK";

pub(crate) fn kind(provider: &str) -> Option<Kind> {
    match super::provider_config::definition(provider)?["cloud"].as_str()? {
        "azure" => Some(Kind::Azure),
        "bedrock" => Some(Kind::Bedrock),
        "vertex" => Some(Kind::Vertex),
        _ => None,
    }
}

pub(crate) fn loopback_allowed() -> bool {
    std::env::var(LOOPBACK_ENV).is_ok_and(|value| value == "1")
}

fn matches_pattern(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).is_ok_and(|regex| regex.is_match(value))
}

fn text<'a>(input: &'a Settings, key: &str) -> Result<Option<&'a str>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.chars().count() > 300 || value.chars().any(char::is_control) {
                return Err(format!("{key} is invalid"));
            }
            Ok(Some(value).filter(|value| !value.is_empty()))
        }
        Some(_) => Err(format!("{key} must be text")),
    }
}

fn required<'a>(input: &'a Settings, key: &str) -> Result<&'a str, String> {
    text(input, key)?.ok_or_else(|| format!("{key} is required"))
}

fn origin(input: &str, suffixes: &[&str], allow_loopback: bool) -> Result<String, String> {
    let url = Url::parse(input).map_err(|_| "Endpoint must be a valid URL".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "Endpoint must be a bare origin without credentials, path, query or fragment".into(),
        );
    }
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(name)) => name == "localhost",
        None => return Err("Endpoint must include a host".into()),
    };
    if loopback {
        if !allow_loopback || !matches!(url.scheme(), "http" | "https") {
            return Err("Loopback endpoints are not allowed".into());
        }
        return Ok(url.origin().ascii_serialization());
    }
    let Some(Host::Domain(host)) = url.host() else {
        return Err("Endpoint must use a DNS name, not an IP address".into());
    };
    if url.scheme() != "https" || url.port().is_some() {
        return Err("Endpoint must use HTTPS on the default port".into());
    }
    if !suffixes
        .iter()
        .any(|suffix| host.len() > suffix.len() && host.ends_with(suffix))
    {
        return Err("Endpoint host is not an allowed cloud provider host".into());
    }
    Ok(format!("https://{host}"))
}

pub(crate) fn validate_settings(
    kind: Kind,
    input: &Settings,
    allow_loopback: bool,
) -> Result<Settings, String> {
    let allowed: &[&str] = match kind {
        Kind::Azure => &["endpoint", "apiVersion", "authHeader"],
        Kind::Bedrock => &["region"],
        Kind::Vertex => &["project", "location"],
    };
    let hidden_endpoint = allow_loopback && kind != Kind::Azure;
    if let Some(key) = input
        .keys()
        .find(|key| !allowed.contains(&key.as_str()) && !(hidden_endpoint && *key == "endpoint"))
    {
        return Err(format!("Unknown setting {key}"));
    }
    let mut out = Settings::new();
    match kind {
        Kind::Azure => {
            out.insert(
                "endpoint".into(),
                json!(origin(
                    required(input, "endpoint")?,
                    AZURE_SUFFIXES,
                    allow_loopback
                )?),
            );
            let version = required(input, "apiVersion")?;
            if !matches_pattern(
                r"^(v1|preview|[0-9]{4}-[0-9]{2}-[0-9]{2}(-preview)?)$",
                version,
            ) {
                return Err(
                    "apiVersion must look like 2024-10-21, 2025-04-01-preview or v1".into(),
                );
            }
            out.insert("apiVersion".into(), json!(version));
            let header = text(input, "authHeader")?.unwrap_or("api-key");
            if !matches!(header, "api-key" | "bearer") {
                return Err("authHeader must be api-key or bearer".into());
            }
            out.insert("authHeader".into(), json!(header));
        }
        Kind::Bedrock => {
            let region = required(input, "region")?;
            if !matches_pattern(r"^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$", region) {
                return Err("region must look like us-west-2".into());
            }
            out.insert("region".into(), json!(region));
        }
        Kind::Vertex => {
            let project = required(input, "project")?;
            if !matches_pattern(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$", project) {
                return Err("project must be a Google Cloud project ID".into());
            }
            let location = required(input, "location")?;
            if !matches_pattern(r"^(global|[a-z]+-[a-z]+[0-9]+)$", location) {
                return Err("location must be global or look like us-central1".into());
            }
            out.insert("project".into(), json!(project));
            out.insert("location".into(), json!(location));
        }
    }
    if hidden_endpoint {
        if let Some(endpoint) = text(input, "endpoint")? {
            out.insert("endpoint".into(), json!(origin(endpoint, &[], true)?));
        }
    }
    Ok(out)
}

pub(crate) fn pack(
    provider: &str,
    api_key: &str,
    settings: Option<&Settings>,
    allow_loopback: bool,
) -> Result<String, String> {
    let kind = kind(provider).ok_or("Provider does not take endpoint settings")?;
    let settings = validate_settings(
        kind,
        settings.ok_or("Provider settings are required")?,
        allow_loopback,
    )?;
    Ok(json!({"v":1,"apiKey":api_key,"settings":settings}).to_string())
}

pub(crate) fn unpack(secret: &str) -> Result<(String, Settings), String> {
    let value: Value = serde_json::from_str(secret).map_err(|_| {
        "Provider settings are missing; save the API key and settings again".to_string()
    })?;
    match (
        value["v"].as_u64(),
        value["apiKey"].as_str(),
        value["settings"].as_object(),
    ) {
        (Some(1), Some(key), Some(settings)) if !key.is_empty() => {
            Ok((key.to_owned(), settings.clone()))
        }
        _ => Err("Provider settings are missing; save the API key and settings again".into()),
    }
}

pub(crate) fn api_key(provider: &str, stored: &str) -> String {
    if kind(provider).is_some() {
        if let Ok((key, _)) = unpack(stored) {
            return key;
        }
    }
    stored.to_owned()
}

pub(crate) fn public_settings(provider: &str, stored: &str) -> Value {
    if kind(provider).is_some() {
        if let Ok((_, settings)) = unpack(stored) {
            return Value::Object(settings);
        }
    }
    Value::Null
}

pub(crate) fn resolve(
    provider: &str,
    transport: &str,
    model: &str,
    stored: &str,
    allow_loopback: bool,
) -> Result<Route, String> {
    let kind = kind(provider).ok_or("Provider does not take endpoint settings")?;
    let (token, raw) = unpack(stored)?;
    let settings = validate_settings(kind, &raw, allow_loopback)?;
    let get = |key: &str| settings[key].as_str().unwrap_or_default().to_owned();
    let (base, path, query) = match kind {
        Kind::Azure => {
            let version = get("apiVersion");
            let (path, query) = match (version.as_str(), transport) {
                ("v1", "openai-responses") => ("/openai/v1/responses".to_owned(), None),
                ("v1", _) => ("/openai/v1/chat/completions".to_owned(), None),
                (_, "openai-responses") => ("/openai/responses".to_owned(), Some(version)),
                (_, _) => {
                    if !matches_pattern(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", model) {
                        return Err(
                            "Azure deployment names may contain letters, digits, '.', '_' and '-'"
                                .into(),
                        );
                    }
                    (
                        format!("/openai/deployments/{model}/chat/completions"),
                        Some(version),
                    )
                }
            };
            (get("endpoint"), path, query)
        }
        Kind::Bedrock => {
            if transport != "openai-chat" {
                return Err("Bedrock supports Chat Completions only".into());
            }
            let base = settings
                .get("endpoint")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!("https://bedrock-runtime.{}.amazonaws.com", get("region"))
                });
            (base, "/openai/v1/chat/completions".to_owned(), None)
        }
        Kind::Vertex => {
            if transport != "openai-chat" {
                return Err("Vertex AI supports Chat Completions only".into());
            }
            let location = get("location");
            let base = settings
                .get("endpoint")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if location == "global" {
                        "https://aiplatform.googleapis.com".to_owned()
                    } else {
                        format!("https://{location}-aiplatform.googleapis.com")
                    }
                });
            let path = format!(
                "/v1/projects/{}/locations/{location}/endpoints/openapi/chat/completions",
                get("project")
            );
            (base, path, None)
        }
    };
    let mut url = Url::parse(&base).map_err(|_| "Invalid provider endpoint".to_string())?;
    url.set_path(&path);
    if let Some(version) = query {
        url.set_query(Some(&format!("api-version={version}")));
    }
    let api_key_header =
        (kind == Kind::Azure && settings["authHeader"] == "api-key").then(|| token.clone());
    Ok(Route {
        url: url.into(),
        bearer: api_key_header.is_none().then_some(token),
        api_key_header,
    })
}

pub(crate) fn status_hint(status: u16) -> &'static str {
    match status {
        401 | 403 => "The provider rejected the credential; check the key or token, its permissions and expiry.",
        404 => "Check the endpoint, region or project, deployment or model name, and API version.",
        429 => "The provider rate limit or quota was reached; retry later.",
        500..=599 => "The provider reported a server error; retry later.",
        _ => "Check the API key, model, quota, and endpoint settings.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> Settings {
        value.as_object().unwrap().clone()
    }

    fn azure(version: &str) -> Settings {
        map(json!({"endpoint":"https://Res-1.openai.azure.com/","apiVersion":version}))
    }

    #[test]
    fn azure_urls_follow_the_documented_deployment_and_responses_routes() {
        let stored = pack("azure-foundry", "k1", Some(&azure("2024-10-21")), false).unwrap();
        assert_eq!(
            resolve("azure-foundry", "openai-chat", "my-gpt.4", &stored, false).unwrap(),
            Route {
                url: "https://res-1.openai.azure.com/openai/deployments/my-gpt.4/chat/completions?api-version=2024-10-21".into(),
                api_key_header: Some("k1".into()),
                bearer: None
            }
        );
        assert_eq!(
            resolve("azure-foundry", "openai-responses", "gpt-5", &stored, false)
                .unwrap()
                .url,
            "https://res-1.openai.azure.com/openai/responses?api-version=2024-10-21"
        );
        let v1 = pack("azure-foundry", "k1", Some(&azure("v1")), false).unwrap();
        assert_eq!(
            resolve("azure-foundry", "openai-chat", "d", &v1, false)
                .unwrap()
                .url,
            "https://res-1.openai.azure.com/openai/v1/chat/completions"
        );
        let mut bearer = azure("2024-10-21");
        bearer.insert("authHeader".into(), json!("bearer"));
        let stored = pack("azure-foundry", "tok", Some(&bearer), false).unwrap();
        let route = resolve("azure-foundry", "openai-chat", "d", &stored, false).unwrap();
        assert_eq!(
            (route.api_key_header, route.bearer),
            (None, Some("tok".into()))
        );
    }

    #[test]
    fn azure_rejects_path_injection_in_deployment_names() {
        let stored = pack("azure-foundry", "k1", Some(&azure("2024-10-21")), false).unwrap();
        for model in ["../x", "a/b", "a?b", "", ".."] {
            assert!(resolve("azure-foundry", "openai-chat", model, &stored, false).is_err());
        }
    }

    #[test]
    fn bedrock_and_vertex_routes_are_derived_from_region_project_and_location() {
        let stored = pack(
            "bedrock",
            "br-key",
            Some(&map(json!({"region":"us-west-2"}))),
            false,
        )
        .unwrap();
        assert_eq!(
            resolve(
                "bedrock",
                "openai-chat",
                "openai.gpt-oss-20b-1:0",
                &stored,
                false
            )
            .unwrap(),
            Route {
                url: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions"
                    .into(),
                api_key_header: None,
                bearer: Some("br-key".into())
            }
        );
        let regional = pack(
            "vertex",
            "ya29.x",
            Some(&map(
                json!({"project":"my-proj-123","location":"us-central1"}),
            )),
            false,
        )
        .unwrap();
        assert_eq!(
            resolve("vertex", "openai-chat", "google/gemini-2.5-pro", &regional, false).unwrap().url,
            "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj-123/locations/us-central1/endpoints/openapi/chat/completions"
        );
        let global = pack(
            "vertex",
            "ya29.x",
            Some(&map(json!({"project":"my-proj-123","location":"global"}))),
            false,
        )
        .unwrap();
        assert_eq!(
            resolve("vertex", "openai-chat", "m", &global, false).unwrap().url,
            "https://aiplatform.googleapis.com/v1/projects/my-proj-123/locations/global/endpoints/openapi/chat/completions"
        );
        assert!(resolve("bedrock", "openai-responses", "m", &stored, false).is_err());
    }

    #[test]
    fn settings_validation_blocks_ssrf_credentials_and_malformed_fields() {
        let bad_endpoints = [
            "http://res.openai.azure.com",
            "https://res.openai.azure.com:8443",
            "https://user:pw@res.openai.azure.com",
            "https://res.openai.azure.com/path",
            "https://res.openai.azure.com/?key=1",
            "https://res.openai.azure.com/#x",
            "https://openai.azure.com",
            "https://evil.example.com",
            "https://res.openai.azure.com.evil.example.com",
            "https://169.254.169.254",
            "http://127.0.0.1:8080",
            "https://localhost",
            "https://[::1]",
        ];
        for endpoint in bad_endpoints {
            let settings = map(json!({"endpoint":endpoint,"apiVersion":"2024-10-21"}));
            assert!(
                validate_settings(Kind::Azure, &settings, false).is_err(),
                "{endpoint}"
            );
        }
        for version in ["", "latest", "2024-10-21&x=1", "2024-1-1"] {
            assert!(
                validate_settings(Kind::Azure, &azure(version), false).is_err(),
                "{version}"
            );
        }
        let mut header = azure("2024-10-21");
        header.insert("authHeader".into(), json!("x-other"));
        assert!(validate_settings(Kind::Azure, &header, false).is_err());
        for region in ["", "us west", "US-WEST-2", "../x", "us-west-2.evil.com"] {
            assert!(
                validate_settings(Kind::Bedrock, &map(json!({"region":region})), false).is_err()
            );
        }
        for (project, location) in [
            ("Bad", "us-central1"),
            ("my-proj-123", "us/central1"),
            ("my-proj-123", ""),
        ] {
            assert!(validate_settings(
                Kind::Vertex,
                &map(json!({"project":project,"location":location})),
                false
            )
            .is_err());
        }
        assert!(validate_settings(
            Kind::Bedrock,
            &map(json!({"region":"us-west-2","endpoint":"http://127.0.0.1:1"})),
            false
        )
        .is_err());
        assert!(validate_settings(
            Kind::Bedrock,
            &map(json!({"region":"us-west-2","extra":"x"})),
            true
        )
        .is_err());
    }

    #[test]
    fn loopback_is_only_accepted_when_the_test_gate_is_open() {
        let settings = map(json!({"endpoint":"http://127.0.0.1:4567","apiVersion":"2024-10-21"}));
        assert!(pack("azure-foundry", "k", Some(&settings), false).is_err());
        let stored = pack("azure-foundry", "k", Some(&settings), true).unwrap();
        assert!(resolve("azure-foundry", "openai-chat", "d", &stored, false).is_err());
        assert_eq!(
            resolve("azure-foundry", "openai-chat", "d", &stored, true)
                .unwrap()
                .url,
            "http://127.0.0.1:4567/openai/deployments/d/chat/completions?api-version=2024-10-21"
        );
    }

    #[test]
    fn packed_credentials_round_trip_and_unpacked_keys_are_masked_source() {
        let stored = pack(
            "bedrock",
            "sekret-key",
            Some(&map(json!({"region":"eu-west-1"}))),
            false,
        )
        .unwrap();
        assert_eq!(api_key("bedrock", &stored), "sekret-key");
        assert_eq!(
            public_settings("bedrock", &stored),
            json!({"region":"eu-west-1"})
        );
        assert_eq!(api_key("deepseek", "plain"), "plain");
        assert_eq!(public_settings("deepseek", "plain"), Value::Null);
        assert!(unpack("plain-secret").is_err());
        assert!(
            resolve("bedrock", "openai-chat", "m", "plain-secret", false)
                .unwrap_err()
                .contains("settings are missing")
        );
    }

    #[test]
    fn catalog_marks_cloud_providers_as_supported_and_copilot_family_as_not() {
        for id in ["azure-foundry", "bedrock", "vertex"] {
            assert!(super::super::supports(id), "{id}");
            assert!(kind(id).is_some());
        }
        for id in ["copilot", "moa", "copilot-acp"] {
            assert!(!super::super::supports(id), "{id}");
        }
    }
}
