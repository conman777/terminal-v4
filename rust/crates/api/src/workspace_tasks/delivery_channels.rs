//! Outbound result delivery over public webhook APIs: Slack incoming webhook, Discord webhook
//! and a generic HMAC-signed HTTP webhook. Every channel is off until the owner configures it.
//! Endpoint URLs and signing secrets are encrypted with the vault cipher and never logged.
use super::*;
use crate::vault::VaultCipher;
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::Duration;

const URL_LIMIT: usize = 2048;
const SECRET_MIN: usize = 16;
const SECRET_MAX: usize = 256;
const SLACK_CHARS: usize = 3000;
const DISCORD_CHARS: usize = 1900;
const WEBHOOK_CHARS: usize = 8000;
const SEND_ATTEMPTS: u32 = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_AFTER_CAP_MS: u64 = 5000;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
static ALLOW_LOOPBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Channel {
    Slack,
    Discord,
    Webhook,
}

impl Channel {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "slack" => Some(Self::Slack),
            "discord" => Some(Self::Discord),
            "webhook" => Some(Self::Webhook),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Slack => "Slack",
            Self::Discord => "Discord",
            Self::Webhook => "Webhook",
        }
    }
}

/// Test-only escape hatch: loopback targets over plain http. Private ranges stay blocked.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Policy {
    pub allow_loopback: bool,
}

fn policy() -> Policy {
    #[cfg(test)]
    {
        Policy {
            allow_loopback: ALLOW_LOOPBACK.load(std::sync::atomic::Ordering::SeqCst),
        }
    }
    #[cfg(not(test))]
    {
        Policy::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SendError {
    reason: &'static str,
    skipped: bool,
}

impl SendError {
    const fn failed(reason: &'static str) -> Self {
        Self {
            reason,
            skipped: false,
        }
    }
    pub(super) fn reason(&self) -> &'static str {
        self.reason
    }
    pub(super) fn skipped(&self) -> bool {
        self.skipped
    }
}

const NOT_CONFIGURED: SendError = SendError {
    reason: "This delivery channel is not configured",
    skipped: true,
};
const UNREADABLE: SendError = SendError::failed("The saved delivery settings could not be read");
const BLOCKED: SendError =
    SendError::failed("The delivery target is not allowed; nothing was sent");
const REJECTED: SendError = SendError::failed("The delivery endpoint did not accept the message");
const UNCONFIRMED: SendError = SendError::failed(
    "The message may have been sent; delivery could not be confirmed and was not retried",
);
const UNREACHABLE: SendError =
    SendError::failed("The delivery endpoint could not be reached after retries");

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Endpoint {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OwnerChannels {
    owner: String,
    #[serde(default)]
    slack: Option<Endpoint>,
    #[serde(default)]
    discord: Option<Endpoint>,
    #[serde(default)]
    webhook: Option<Endpoint>,
}

impl OwnerChannels {
    fn slot(&mut self, channel: Channel) -> &mut Option<Endpoint> {
        match channel {
            Channel::Slack => &mut self.slack,
            Channel::Discord => &mut self.discord,
            Channel::Webhook => &mut self.webhook,
        }
    }
    fn get(&self, channel: Channel) -> Option<&Endpoint> {
        match channel {
            Channel::Slack => self.slack.as_ref(),
            Channel::Discord => self.discord.as_ref(),
            Channel::Webhook => self.webhook.as_ref(),
        }
    }
}

pub(super) fn is_configured(data_dir: &FsPath, owner: &str, name: &str) -> bool {
    Channel::parse(name).is_some_and(|channel| {
        load(data_dir, owner).is_ok_and(|config| config.get(channel).is_some())
    })
}

fn config_path(data_dir: &FsPath, owner: &str) -> PathBuf {
    data_dir.join("delivery-channels").join(format!(
        "{}.json",
        hex::encode(Sha256::digest(owner.as_bytes()))
    ))
}

fn load(data_dir: &FsPath, owner: &str) -> Result<OwnerChannels, ()> {
    match std::fs::read(config_path(data_dir, owner)) {
        Ok(bytes) => serde_json::from_slice::<OwnerChannels>(&bytes)
            .ok()
            .filter(|config| config.owner == owner)
            .ok_or(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(OwnerChannels {
            owner: owner.into(),
            ..Default::default()
        }),
        Err(_) => Err(()),
    }
}

fn save(data_dir: &FsPath, config: &OwnerChannels) -> Result<(), ApiError> {
    let path = config_path(data_dir, &config.owner);
    let dir = path
        .parent()
        .ok_or_else(|| ApiError::internal("Delivery settings unavailable"))?;
    std::fs::create_dir_all(dir)
        .map_err(|_| ApiError::internal("Delivery settings unavailable"))?;
    let bytes = serde_json::to_vec(config)
        .map_err(|_| ApiError::internal("Delivery settings unavailable"))?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)
    };
    write().map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        ApiError::internal("Delivery settings could not be saved")
    })
}

/// True for loopback, private, link-local, shared, reserved, multicast and unspecified addresses.
pub(super) fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return blocked_v4(mapped);
            }
            let first = v6.segments()[0];
            v6 == Ipv6Addr::UNSPECIFIED
                || v6 == Ipv6Addr::LOCALHOST
                || v6.is_multicast()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
                || first & 0xffc0 == 0xfec0
                || (first == 0x2001 && v6.segments()[1] == 0x0db8)
                || (first == 0x0064 && v6.segments()[1] == 0xff9b)
                || first == 0x2002
        }
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
}

fn loopback_name(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn bad(message: &str) -> ApiError {
    ApiError::bad_request(message)
}

/// Validates a configured endpoint without touching the network.
pub(super) fn validate_endpoint(
    channel: Channel,
    raw: &str,
    secret: Option<&str>,
    policy: Policy,
) -> Result<url::Url, ApiError> {
    if raw.is_empty()
        || raw.len() > URL_LIMIT
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("Enter a valid webhook URL"));
    }
    let url = url::Url::parse(raw).map_err(|_| bad("Enter a valid webhook URL"))?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(bad(
            "The webhook URL must not contain credentials or a fragment",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| bad("Enter a valid webhook URL"))?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let local_ok = policy.allow_loopback && loopback_name(host);
    if !local_ok {
        if url.scheme() != "https" {
            return Err(bad("The webhook URL must use https"));
        }
        let lower = host.to_ascii_lowercase();
        let ip = host.parse::<IpAddr>().ok();
        if ip.is_some_and(is_blocked_ip)
            || lower == "localhost"
            || lower.ends_with(".localhost")
            || lower.ends_with(".local")
            || lower.ends_with(".internal")
            || lower.ends_with(".lan")
            || !lower.contains('.') && ip.is_none()
        {
            return Err(bad("The webhook URL points at a private or local address"));
        }
        let path = url.path();
        match channel {
            Channel::Slack if lower != "hooks.slack.com" || !path.starts_with("/services/") => {
                return Err(bad(
                    "Use a Slack incoming webhook URL (hooks.slack.com/services/...)",
                ));
            }
            Channel::Discord
                if ![
                    "discord.com",
                    "discordapp.com",
                    "ptb.discord.com",
                    "canary.discord.com",
                ]
                .contains(&lower.as_str())
                    || !path.starts_with("/api/webhooks/") =>
            {
                return Err(bad(
                    "Use a Discord webhook URL (discord.com/api/webhooks/...)",
                ));
            }
            _ => {}
        }
    }
    if channel == Channel::Webhook {
        let len = secret.map_or(0, str::len);
        if !(SECRET_MIN..=SECRET_MAX).contains(&len) {
            return Err(bad("A signing secret of 16 to 256 characters is required"));
        }
    }
    Ok(url)
}

pub(super) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

pub(super) fn signature_header(secret: &str, timestamp: u64, body: &[u8]) -> String {
    let mut signed = format!("{timestamp}.").into_bytes();
    signed.extend_from_slice(body);
    format!(
        "sha256={}",
        hex::encode(hmac_sha256(secret.as_bytes(), &signed))
    )
}

fn bounded(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit).collect();
    cut.push_str("\n[truncated]");
    cut
}

fn slack_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn build_body(channel: Channel, task_id: Uuid, text: &str) -> Vec<u8> {
    let value = match channel {
        Channel::Slack => serde_json::json!({ "text": slack_escape(&bounded(text, SLACK_CHARS)) }),
        Channel::Discord => serde_json::json!({
            "content": bounded(text, DISCORD_CHARS),
            "allowed_mentions": { "parse": [] },
        }),
        Channel::Webhook => serde_json::json!({
            "event": "schedule_result",
            "deliveryId": task_id,
            "text": bounded(text, WEBHOOK_CHARS),
        }),
    };
    serde_json::to_vec(&value).unwrap_or_default()
}

async fn client_for(url: &url::Url, policy: Policy) -> Result<reqwest::Client, SendError> {
    let host = url
        .host_str()
        .ok_or(BLOCKED)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = url.port_or_known_default().ok_or(BLOCKED)?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(REQUEST_TIMEOUT)
        .no_proxy();
    let local_ok = policy.allow_loopback && loopback_name(&host);
    if !local_ok {
        let addrs: Vec<_> = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![std::net::SocketAddr::new(ip, port)]
        } else {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|_| UNREACHABLE)?
                .collect()
        };
        if addrs.is_empty() || addrs.iter().any(|addr| is_blocked_ip(addr.ip())) {
            return Err(BLOCKED);
        }
        builder = builder.resolve_to_addrs(&host, &addrs);
    }
    builder.build().map_err(|_| BLOCKED)
}

fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    let base: u64 = if cfg!(test) { 5 } else { 400 };
    let cap = if cfg!(test) { 20 } else { RETRY_AFTER_CAP_MS };
    let wait = retry_after.map_or(base << attempt, |seconds| seconds.saturating_mul(1000));
    Duration::from_millis(wait.min(cap))
}

async fn post(
    url: &url::Url,
    policy: Policy,
    body: Vec<u8>,
    headers: Vec<(&'static str, String)>,
) -> Result<(), SendError> {
    for attempt in 0..SEND_ATTEMPTS {
        let client = client_for(url, policy).await;
        let client = match client {
            Ok(client) => client,
            Err(error) if error == UNREACHABLE && attempt + 1 < SEND_ATTEMPTS => {
                tokio::time::sleep(backoff(attempt, None)).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut request = client
            .post(url.clone())
            .header("content-type", "application/json")
            .body(body.clone());
        for (name, value) in &headers {
            request = request.header(*name, value);
        }
        let retry_after = match request.send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let status = response.status();
                if status != StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                    return Err(REJECTED);
                }
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse::<u64>().ok())
            }
            Err(error) if error.is_connect() => None,
            Err(_) => return Err(UNCONFIRMED),
        };
        if attempt + 1 == SEND_ATTEMPTS {
            return Err(REJECTED);
        }
        tokio::time::sleep(backoff(attempt, retry_after)).await;
    }
    Err(UNREACHABLE)
}

/// Delivers `text` for `task_id` over `channel` for `owner`; skipped when not configured.
pub(super) async fn send(
    data_dir: &FsPath,
    owner: &str,
    channel: Channel,
    task_id: Uuid,
    text: &str,
) -> Result<(), SendError> {
    send_with_policy(data_dir, owner, channel, task_id, text, policy()).await
}

pub(super) async fn send_with_policy(
    data_dir: &FsPath,
    owner: &str,
    channel: Channel,
    task_id: Uuid,
    text: &str,
    policy: Policy,
) -> Result<(), SendError> {
    let config = load(data_dir, owner).map_err(|_| UNREADABLE)?;
    let endpoint = config.get(channel).ok_or(NOT_CONFIGURED)?;
    let cipher = VaultCipher::load(data_dir).map_err(|_| UNREADABLE)?;
    let raw = cipher.decrypt(&endpoint.url).map_err(|_| UNREADABLE)?;
    let secret = endpoint
        .secret
        .as_ref()
        .map(|secret| cipher.decrypt(secret))
        .transpose()
        .map_err(|_| UNREADABLE)?;
    let url = validate_endpoint(channel, &raw, secret.as_deref(), policy).map_err(|_| BLOCKED)?;
    let body = build_body(channel, task_id, text);
    let mut headers = Vec::new();
    if channel == Channel::Webhook {
        let timestamp = now_ms() / 1000;
        let secret = secret.ok_or(UNREADABLE)?;
        headers.push(("x-terminal-v4-timestamp", timestamp.to_string()));
        headers.push(("x-terminal-v4-delivery-id", task_id.to_string()));
        headers.push((
            "x-terminal-v4-signature",
            signature_header(&secret, timestamp, &body),
        ));
    }
    let result = post(&url, policy, body, headers).await;
    if let Err(error) = &result {
        tracing::warn!(channel = channel.label(), task_id = %task_id, reason = error.reason, "Schedule result delivery failed");
    }
    result
}

#[derive(Deserialize)]
struct EndpointInput {
    url: String,
    #[serde(default)]
    secret: Option<String>,
}

fn parse_channel(name: &str) -> Result<Channel, ApiError> {
    Channel::parse(name).ok_or_else(|| ApiError::not_found("Unknown delivery channel"))
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let config = load(&state.config().data_dir, &user.user_id)
        .map_err(|_| ApiError::internal("Delivery settings could not be read"))?;
    let entry =
        |channel: Channel| serde_json::json!({ "configured": config.get(channel).is_some() });
    Ok(Json(serde_json::json!({
        "slack": entry(Channel::Slack),
        "discord": entry(Channel::Discord),
        "webhook": entry(Channel::Webhook),
    })))
}

async fn configure(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(name): Path<String>,
    Json(input): Json<EndpointInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let channel = parse_channel(&name)?;
    let url = input.url.trim();
    let secret = input
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    validate_endpoint(channel, url, secret, policy())?;
    let data_dir = state.config().data_dir.clone();
    let cipher = VaultCipher::load(&data_dir).map_err(ApiError::internal)?;
    let endpoint = Endpoint {
        url: cipher.encrypt(url).map_err(ApiError::internal)?,
        secret: match (channel, secret) {
            (Channel::Webhook, Some(secret)) => {
                Some(cipher.encrypt(secret).map_err(ApiError::internal)?)
            }
            _ => None,
        },
    };
    let owner = user.user_id;
    tokio::task::spawn_blocking(move || {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Delivery settings unavailable"))?;
        let mut config = load(&data_dir, &owner)
            .map_err(|_| ApiError::internal("Delivery settings could not be read"))?;
        *config.slot(channel) = Some(endpoint);
        save(&data_dir, &config)
    })
    .await
    .map_err(|_| ApiError::internal("Delivery settings unavailable"))??;
    Ok(Json(
        serde_json::json!({ "channel": name, "configured": true }),
    ))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let channel = parse_channel(&name)?;
    let data_dir = state.config().data_dir.clone();
    let owner = user.user_id;
    tokio::task::spawn_blocking(move || {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| ApiError::internal("Delivery settings unavailable"))?;
        let mut config = load(&data_dir, &owner)
            .map_err(|_| ApiError::internal("Delivery settings could not be read"))?;
        *config.slot(channel) = None;
        save(&data_dir, &config)
    })
    .await
    .map_err(|_| ApiError::internal("Delivery settings unavailable"))??;
    Ok(Json(
        serde_json::json!({ "channel": name, "configured": false }),
    ))
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/delivery-channels",
            axum::routing::get(status),
        )
        .route(
            "/api/workspace/delivery-channels/{channel}",
            axum::routing::put(configure).delete(remove),
        )
}

#[cfg(test)]
#[path = "delivery_channels_tests.rs"]
mod tests;
