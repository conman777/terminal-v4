use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::{Host, Url};

#[path = "cloud_provider_converse.rs"]
pub(crate) mod converse;
#[path = "cloud_provider_sigv4.rs"]
pub(crate) mod sigv4;
#[path = "cloud_provider_vertex.rs"]
pub(crate) mod vertex;

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
const DYNAMIC_PREFIX: &str = "\u{1}v4-cloud:";
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
    let hidden_token_endpoint = allow_loopback && kind == Kind::Vertex;
    if let Some(key) = input.keys().find(|key| {
        !allowed.contains(&key.as_str())
            && !(hidden_endpoint && *key == "endpoint")
            && !(hidden_token_endpoint && *key == "tokenEndpoint")
    }) {
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
    if hidden_token_endpoint {
        if let Some(endpoint) = text(input, "tokenEndpoint")? {
            out.insert("tokenEndpoint".into(), json!(loopback_url(endpoint)?));
        }
    }
    Ok(out)
}

fn loopback_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input).map_err(|_| "Token endpoint must be a valid URL".to_string())?;
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(name)) => name == "localhost",
        None => false,
    };
    if !loopback
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Token endpoint overrides must be loopback URLs".into());
    }
    Ok(url.into())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AwsKeys {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Sigv4Secret {
    region: String,
    #[serde(flatten)]
    keys: AwsKeys,
}

fn is_structured(key: &str) -> bool {
    key.starts_with('{')
}

fn parse_aws_keys(raw: &str) -> Result<AwsKeys, String> {
    let invalid = || {
        "AWS credentials must be JSON with accessKeyId, secretAccessKey and optional sessionToken"
            .to_string()
    };
    let keys: AwsKeys = serde_json::from_str(raw).map_err(|_| invalid())?;
    let plain = |value: &str, min: usize, max: usize| {
        (min..=max).contains(&value.len()) && value.chars().all(|c| c.is_ascii_graphic())
    };
    if !plain(&keys.access_key_id, 16, 128)
        || !keys
            .access_key_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric())
        || !plain(&keys.secret_access_key, 16, 256)
        || keys
            .session_token
            .as_deref()
            .is_some_and(|t| !plain(t, 1, 8192))
    {
        return Err(invalid());
    }
    Ok(keys)
}

fn validate_structured_key(kind: Kind, key: &str) -> Result<(), String> {
    if !is_structured(key) || kind == Kind::Azure {
        return Ok(());
    }
    match kind {
        Kind::Bedrock => parse_aws_keys(key).map(drop),
        Kind::Vertex => vertex::parse_key_file(key).map(drop),
        Kind::Azure => Ok(()),
    }
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
    validate_structured_key(kind, api_key)?;
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
    let token = if kind != Kind::Azure && is_structured(&token) {
        dynamic_secret(kind, &token, &settings)?
    } else {
        token
    };
    Ok(Route {
        url: url.into(),
        bearer: api_key_header.is_none().then_some(token),
        api_key_header,
    })
}

fn dynamic_secret(kind: Kind, key: &str, settings: &Settings) -> Result<String, String> {
    let payload = match kind {
        Kind::Bedrock => {
            let secret = Sigv4Secret {
                region: settings["region"].as_str().unwrap_or_default().to_owned(),
                keys: parse_aws_keys(key)?,
            };
            format!(
                "sigv4:{}",
                serde_json::to_string(&secret).map_err(|_| "Invalid AWS credentials")?
            )
        }
        Kind::Vertex => {
            let mut account = vertex::parse_key_file(key)?;
            account.token_endpoint = settings
                .get("tokenEndpoint")
                .and_then(Value::as_str)
                .unwrap_or(vertex::GOOGLE_TOKEN_ENDPOINT)
                .to_owned();
            format!(
                "vertex:{}",
                serde_json::to_string(&account).map_err(|_| "Invalid service account")?
            )
        }
        Kind::Azure => return Err("Azure credentials must be a plain API key".into()),
    };
    Ok(format!("{DYNAMIC_PREFIX}{payload}"))
}

pub(crate) struct Converse {
    pub(crate) body: Value,
    pub(crate) text: String,
}

fn encode_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

pub(crate) async fn bearer(client: &reqwest::Client, secret: &str) -> Result<String, String> {
    let Some(account) = secret
        .strip_prefix(DYNAMIC_PREFIX)
        .and_then(|rest| rest.strip_prefix("vertex:"))
    else {
        return Ok(secret.to_owned());
    };
    let account: vertex::ServiceAccount =
        serde_json::from_str(account).map_err(|_| "Invalid service-account credential")?;
    vertex::access_token(client, &account).await
}

pub(crate) async fn converse(
    client: &reqwest::Client,
    base_url: &str,
    secret: &str,
    body: &Value,
) -> Result<Option<Converse>, String> {
    let Some(rest) = secret
        .strip_prefix(DYNAMIC_PREFIX)
        .and_then(|rest| rest.strip_prefix("sigv4:"))
    else {
        return Ok(None);
    };
    let aws: Sigv4Secret = serde_json::from_str(rest).map_err(|_| "Invalid AWS credential")?;
    let model = body["model"]
        .as_str()
        .filter(|model| matches_pattern(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$", model))
        .ok_or("Bedrock model IDs may contain letters, digits, '.', '_', ':', '/' and '-'")?;
    let base = Url::parse(base_url).map_err(|_| "Invalid provider endpoint".to_string())?;
    let path = format!("/model/{}/converse", encode_segment(model));
    let target = Url::parse(&format!("{}{path}", base.origin().ascii_serialization()))
        .map_err(|_| "Invalid provider endpoint".to_string())?;
    let host = match (target.host_str(), target.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        _ => return Err("Invalid provider endpoint".into()),
    };
    let payload = serde_json::to_vec(&converse::request(body)?)
        .map_err(|_| "Cannot encode provider request")?;
    let signed = sigv4::sign(
        &sigv4::Request {
            method: "POST",
            host: &host,
            path: &path,
            query: "",
            headers: &[("content-type", "application/json")],
            body: &payload,
        },
        &sigv4::Credentials {
            access_key: &aws.keys.access_key_id,
            secret_key: &aws.keys.secret_access_key,
            session_token: aws.keys.session_token.as_deref(),
        },
        &aws.region,
        "bedrock",
        vertex::now(),
    );
    let sensitive = |value: &str| {
        reqwest::header::HeaderValue::from_str(value)
            .map(|mut value| {
                value.set_sensitive(true);
                value
            })
            .map_err(|_| "Provider credential contains invalid characters".to_string())
    };
    let mut request = client
        .post(target)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("x-amz-date", signed.amz_date)
        .header("Authorization", sensitive(&signed.authorization)?);
    if let Some(token) = &aws.keys.session_token {
        request = request.header("x-amz-security-token", sensitive(token)?);
    }
    let mut response = request
        .body(payload)
        .send()
        .await
        .map_err(|_| "Provider request failed; check connectivity and endpoint settings")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(format!(
            "Provider returned HTTP {status}. {}",
            status_hint(status)
        ));
    }
    let mut contents = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Provider response was interrupted")?
    {
        if contents.len() + chunk.len() > 8_000_000 {
            return Err("Provider response exceeds 8 MB".into());
        }
        contents.extend_from_slice(&chunk);
    }
    let raw: Value =
        serde_json::from_slice(&contents).map_err(|_| "Provider returned invalid JSON")?;
    let body = converse::response(&raw)?;
    let text = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(Some(Converse { body, text }))
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

    const AWS_KEYS: &str = r#"{"accessKeyId":"AKIDEXAMPLE0000001","secretAccessKey":"wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY","sessionToken":"session-token-0001"}"#;

    #[test]
    fn structured_aws_keys_resolve_to_a_signing_secret_without_changing_bearer_routes() {
        let settings = map(json!({"region":"us-west-2"}));
        let stored = pack("bedrock", AWS_KEYS, Some(&settings), false).unwrap();
        let route = resolve("bedrock", "openai-chat", "m", &stored, false).unwrap();
        assert_eq!(route.api_key_header, None);
        let bearer = route.bearer.unwrap();
        assert!(bearer.starts_with(DYNAMIC_PREFIX));
        assert!(bearer.contains("sigv4:") && bearer.contains("us-west-2"));
        let plain = pack("bedrock", "br-key", Some(&settings), false).unwrap();
        assert_eq!(
            resolve("bedrock", "openai-chat", "m", &plain, false)
                .unwrap()
                .bearer,
            Some("br-key".into())
        );
    }

    #[test]
    fn malformed_structured_credentials_are_rejected_without_echoing_secrets() {
        let settings = map(json!({"region":"us-west-2"}));
        for bad in [
            r#"{"accessKeyId":"short","secretAccessKey":"SECRETVALUE0123456789"}"#,
            r#"{"accessKeyId":"AKIDEXAMPLE0000001"}"#,
            r#"{"accessKeyId":"AKIDEXAMPLE0000001","secretAccessKey":"SECRETVALUE0123456789","extra":1}"#,
            r#"{not json SECRETVALUE0123456789"#,
        ] {
            let error = pack("bedrock", bad, Some(&settings), false).unwrap_err();
            assert!(!error.contains("SECRETVALUE"), "{error}");
        }
        let vertex = map(json!({"project":"my-proj-123","location":"global"}));
        let error = pack(
            "vertex",
            r#"{"type":"service_account","client_email":"a@b","private_key":"LEAKYPEM"}"#,
            Some(&vertex),
            false,
        )
        .unwrap_err();
        assert!(!error.contains("LEAKYPEM"), "{error}");
    }

    #[test]
    fn service_account_keys_resolve_to_a_minting_secret_with_a_pinned_google_endpoint() {
        let (private, _) = vertex::test_keys::rsa_pair();
        let key_file = vertex::test_keys::key_file(&private);
        let settings = map(json!({"project":"my-proj-123","location":"global"}));
        let stored = pack("vertex", &key_file, Some(&settings), false).unwrap();
        let route = resolve("vertex", "openai-chat", "m", &stored, false).unwrap();
        let bearer = route.bearer.unwrap();
        assert!(bearer.starts_with(DYNAMIC_PREFIX));
        assert!(bearer.contains(vertex::GOOGLE_TOKEN_ENDPOINT));
        let hidden = map(
            json!({"project":"my-proj-123","location":"global","tokenEndpoint":"http://127.0.0.1:9/token"}),
        );
        assert!(pack("vertex", &key_file, Some(&hidden), false).is_err());
        assert!(pack("vertex", &key_file, Some(&hidden), true).is_ok());
        let remote = map(
            json!({"project":"my-proj-123","location":"global","tokenEndpoint":"https://evil.example.com/token"}),
        );
        assert!(pack("vertex", &key_file, Some(&remote), true).is_err());
    }

    #[tokio::test]
    async fn bearer_passes_plain_secrets_through_and_converse_ignores_them() {
        let client = reqwest::Client::new();
        assert_eq!(bearer(&client, "plain").await.unwrap(), "plain");
        assert!(converse(&client, "http://127.0.0.1:1", "plain", &json!({}))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn converse_rejects_model_ids_that_could_alter_the_signed_path() {
        let stored = pack(
            "bedrock",
            AWS_KEYS,
            Some(&map(json!({"region":"us-west-2"}))),
            false,
        )
        .unwrap();
        let secret = resolve("bedrock", "openai-chat", "m", &stored, false)
            .unwrap()
            .bearer
            .unwrap();
        for model in ["../x", "..", "a b", "a?b", "", "a#b", "/abs"] {
            let result = converse(
                &reqwest::Client::new(),
                "http://127.0.0.1:1",
                &secret,
                &json!({"model":model,"messages":[]}),
            )
            .await;
            assert!(result.is_err(), "{model}");
        }
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
