//! Telegram gateway, like Hermes's messaging gateways: talk to one of your threads from Telegram.
//!
//! The user adds a bot token, then pairs exactly one chat by sending `/pair CODE` to the bot.
//! Messages from any other chat are ignored.
use crate::{
    auth::{AuthenticatedUser, LocalAuthority},
    state::AppState,
    vault::VaultCipher,
    ApiError,
};
use axum::{extract::State, routing::get, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant};
use terminal_v4_core::StructuredSessionEvent;

const POLL_SECONDS: u64 = 25;
const MESSAGE_LIMIT: usize = 4000;
const REPLY_WAIT: Duration = Duration::from_secs(30 * 60);
const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
const PAIRING_MAX_ATTEMPTS: u32 = 5;
const MAX_BACKOFF_SECONDS: u64 = 60;
const SEND_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    owner: String,
    token: String,
    bot_name: String,
    chat_id: Option<i64>,
    session_id: Option<String>,
    enabled: bool,
    #[serde(default)]
    scope_generation: String,
    #[serde(default)]
    cursor_generation: String,
}

struct PairingCode {
    code: String,
    issued: Instant,
    attempts: u32,
}

static PAIRING_CODES: LazyLock<Mutex<HashMap<GateKey, PairingCode>>> =
    LazyLock::new(Default::default);
static THREAD_CHOICES: LazyLock<Mutex<HashMap<GateKey, Vec<String>>>> =
    LazyLock::new(Default::default);
static RUNNING: LazyLock<Mutex<HashSet<GateKey>>> = LazyLock::new(Default::default);
type ConfigGate = tokio::sync::RwLock<u64>;
type GateKey = (PathBuf, String);
static CONFIG_GATES: LazyLock<Mutex<HashMap<GateKey, Weak<ConfigGate>>>> =
    LazyLock::new(Default::default);

fn owner_key(data_dir: &Path, owner: &str) -> Option<GateKey> {
    Some((std::fs::canonicalize(data_dir).ok()?, owner.to_owned()))
}

fn config_gate(data_dir: &Path, owner: &str) -> Option<Arc<ConfigGate>> {
    let key = owner_key(data_dir, owner)?;
    let mut gates = CONFIG_GATES.lock().ok()?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
        return Some(gate);
    }
    let gate = Arc::new(ConfigGate::new(0));
    gates.insert(key, Arc::downgrade(&gate));
    Some(gate)
}

fn scope_matches(current: &Config, expected: &Config, chat_id: i64, bind_session: bool) -> bool {
    current.owner == expected.owner
        && current.token == expected.token
        && current.scope_generation == expected.scope_generation
        && current.enabled
        && current.chat_id == Some(chat_id)
        && (!bind_session || current.session_id == expected.session_id)
}

fn advance_scope(config: &mut Config) {
    config.scope_generation = uuid::Uuid::new_v4().to_string();
}

async fn scope_guard(
    data_dir: &Path,
    expected: &Config,
    chat_id: i64,
    bind_session: bool,
) -> Option<tokio::sync::OwnedRwLockReadGuard<u64>> {
    let guard = config_gate(data_dir, &expected.owner)?.read_owned().await;
    let current = load_config(data_dir, &expected.owner)?;
    scope_matches(&current, expected, chat_id, bind_session).then_some(guard)
}

#[derive(Debug, PartialEq)]
pub(crate) enum Command {
    Pair(String),
    Threads,
    Use(usize),
    Help,
    Message(String),
}

pub(crate) fn parse_command(text: &str) -> Command {
    let text = text.trim();
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let head = head.split('@').next().unwrap_or(head);
    match head {
        "/pair" => Command::Pair(rest.trim().to_owned()),
        "/threads" => Command::Threads,
        "/use" => rest
            .trim()
            .parse()
            .map(Command::Use)
            .unwrap_or(Command::Help),
        "/start" | "/help" => Command::Help,
        _ => Command::Message(text.to_owned()),
    }
}

/// Splits a long reply into Telegram-sized messages, preferring line breaks.
pub(crate) fn chunks(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if current.chars().count() + line.chars().count() > MESSAGE_LIMIT && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        }
        let mut line = line.to_owned();
        while line.chars().count() > MESSAGE_LIMIT {
            let split: String = line.chars().take(MESSAGE_LIMIT).collect();
            line = line.chars().skip(MESSAGE_LIMIT).collect();
            parts.push(split);
        }
        current.push_str(&line);
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

fn api_base() -> String {
    std::env::var("TELEGRAM_API_BASE").unwrap_or_else(|_| "https://api.telegram.org".into())
}

fn config_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("messaging").join("telegram")
}

fn config_path(data_dir: &Path, user_id: &str) -> PathBuf {
    config_dir(data_dir).join(format!(
        "{}.json",
        hex::encode(Sha256::digest(user_id.as_bytes()))
    ))
}

fn load_config(data_dir: &Path, user_id: &str) -> Option<Config> {
    serde_json::from_slice(&std::fs::read(config_path(data_dir, user_id)).ok()?).ok()
}

fn save_config(data_dir: &Path, config: &Config) -> Result<(), ApiError> {
    let path = config_path(data_dir, &config.owner);
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("Invalid messaging path"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| ApiError::internal("Unable to save Telegram settings"))?;
    let file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| ApiError::internal("Unable to save Telegram settings"))?;
    serde_json::to_writer(file.as_file(), config)
        .map_err(|_| ApiError::internal("Unable to save Telegram settings"))?;
    file.persist(&path)
        .map_err(|_| ApiError::internal("Unable to save Telegram settings"))?;
    Ok(())
}

#[derive(Debug)]
struct TelegramError {
    message: String,
    retry_after: Option<u64>,
    unconfirmed: bool,
}

impl TelegramError {
    fn new(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            retry_after: None,
            unconfirmed: true,
        }
    }
}

async fn call(
    token: &str,
    method: &str,
    body: Value,
    timeout: Duration,
) -> Result<Value, TelegramError> {
    call_with_client(&reqwest::Client::new(), token, method, body, timeout).await
}

async fn call_with_client(
    client: &reqwest::Client,
    token: &str,
    method: &str,
    body: Value,
    timeout: Duration,
) -> Result<Value, TelegramError> {
    let response = client
        .post(format!("{}/bot{token}/{method}", api_base()))
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|_| TelegramError::new("Telegram could not be reached"))?;
    let value: Value = response
        .json()
        .await
        .map_err(|_| TelegramError::new("Telegram returned an unexpected reply"))?;
    if value["ok"] == false {
        return Err(TelegramError {
            message: value["description"]
                .as_str()
                .unwrap_or("Telegram refused the request")
                .to_owned(),
            retry_after: value["parameters"]["retry_after"].as_u64(),
            unconfirmed: false,
        });
    }
    if value["ok"] != true {
        return Err(TelegramError::new("Telegram returned an unexpected reply"));
    }
    Ok(value["result"].clone())
}

fn backoff(failures: u32) -> Duration {
    let seconds = 1u64
        .checked_shl(failures.min(10))
        .unwrap_or(MAX_BACKOFF_SECONDS)
        .clamp(2, MAX_BACKOFF_SECONDS);
    Duration::from_secs(seconds)
}

async fn send_part(token: &str, chat_id: i64, part: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
    else {
        return false;
    };
    for attempt in 0..SEND_ATTEMPTS {
        match call_with_client(
            &client,
            token,
            "sendMessage",
            json!({ "chat_id": chat_id, "text": part }),
            Duration::from_secs(20),
        )
        .await
        {
            Ok(_) => return true,
            Err(error)
                if !error.unconfirmed
                    && error.retry_after.is_some()
                    && attempt + 1 < SEND_ATTEMPTS =>
            {
                tokio::time::sleep(Duration::from_secs(error.retry_after.unwrap_or(0).min(30)))
                    .await;
            }
            Err(error) => {
                if error.unconfirmed {
                    tracing::warn!(
                        "Telegram message delivery could not be confirmed; it will not be retried"
                    );
                }
                return false;
            }
        }
    }
    false
}

async fn send_all(token: &str, chat_id: i64, text: &str) -> bool {
    for part in chunks(text) {
        if !send_part(token, chat_id, &part).await {
            return false;
        }
    }
    true
}

async fn send(token: &str, chat_id: i64, text: &str) {
    send_all(token, chat_id, text).await;
}

async fn send_scoped(
    data_dir: &Path,
    expected: &Config,
    token: &str,
    chat_id: i64,
    text: &str,
    bind_session: bool,
) -> bool {
    for part in chunks(text) {
        let Some(_guard) = scope_guard(data_dir, expected, chat_id, bind_session).await else {
            return false;
        };
        if !send_part(token, chat_id, &part).await {
            return false;
        }
    }
    true
}

const OWNER_SEND_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnerSendError {
    NotConnected,
    Disabled,
    NotPaired,
    TokenUnavailable,
    SenderUnavailable,
    Rejected,
    Unconfirmed,
}

impl OwnerSendError {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::NotConnected => "Telegram is not connected",
            Self::Disabled => "The Telegram gateway is turned off",
            Self::NotPaired => "No Telegram chat is paired",
            Self::TokenUnavailable => "The saved Telegram bot token could not be read",
            Self::SenderUnavailable => "Could not prepare the Telegram sender; no message was sent",
            Self::Rejected => "Telegram did not accept the message",
            Self::Unconfirmed => {
                "The Telegram message may have been sent; delivery could not be confirmed and was not retried"
            }
        }
    }

    pub(crate) fn skipped(self) -> bool {
        matches!(self, Self::NotConnected | Self::Disabled | Self::NotPaired)
    }
}

/// Sends bounded text to the chat paired by `owner` and to no other chat.
pub(crate) async fn send_to_owner(
    data_dir: &Path,
    owner: &str,
    text: &str,
) -> Result<(), OwnerSendError> {
    let gate = config_gate(data_dir, owner).ok_or(OwnerSendError::SenderUnavailable)?;
    let _guard = gate.read().await;
    let config = load_config(data_dir, owner)
        .filter(|config| config.owner == owner)
        .ok_or(OwnerSendError::NotConnected)?;
    if !config.enabled {
        return Err(OwnerSendError::Disabled);
    }
    let chat_id = config.chat_id.ok_or(OwnerSendError::NotPaired)?;
    let token = VaultCipher::load(data_dir)
        .and_then(|cipher| cipher.decrypt(&config.token))
        .map_err(|_| OwnerSendError::TokenUnavailable)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| OwnerSendError::SenderUnavailable)?;
    let bounded = if text.chars().count() > OWNER_SEND_CHARS {
        let mut shortened: String = text.chars().take(OWNER_SEND_CHARS).collect();
        shortened.push_str("\n[truncated]");
        shortened
    } else {
        text.to_owned()
    };
    for part in chunks(&bounded) {
        if let Err(error) = call_with_client(
            &client,
            &token,
            "sendMessage",
            json!({ "chat_id": chat_id, "text": part }),
            Duration::from_secs(20),
        )
        .await
        {
            return Err(if error.unconfirmed {
                OwnerSendError::Unconfirmed
            } else {
                OwnerSendError::Rejected
            });
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn seed_paired_for_test(
    data_dir: &Path,
    owner: &str,
    token: &str,
    chat_id: Option<i64>,
    enabled: bool,
) {
    let cipher = VaultCipher::load(data_dir).unwrap();
    save_config(
        data_dir,
        &Config {
            owner: owner.into(),
            token: cipher.encrypt(token).unwrap(),
            bot_name: "test_bot".into(),
            chat_id,
            session_id: None,
            enabled,
            scope_generation: uuid::Uuid::new_v4().to_string(),
            cursor_generation: uuid::Uuid::new_v4().to_string(),
        },
    )
    .unwrap();
}

fn offset_path(data_dir: &Path, user_id: &str) -> PathBuf {
    config_path(data_dir, user_id).with_extension("offset")
}

#[derive(Serialize, Deserialize)]
struct PollCursor {
    generation: String,
    offset: i64,
}

fn load_offset(data_dir: &Path, config: &Config) -> Result<i64, ()> {
    let bytes = match std::fs::read(offset_path(data_dir, &config.owner)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(()),
    };
    if let Ok(cursor) = serde_json::from_slice::<PollCursor>(&bytes) {
        if cursor.offset < 0 {
            return Err(());
        }
        return Ok(if cursor.generation == config.cursor_generation {
            cursor.offset
        } else {
            0
        });
    }
    if let Ok(offset) = std::str::from_utf8(&bytes)
        .map_err(|_| ())?
        .trim()
        .parse::<i64>()
    {
        if offset < 0 {
            return Err(());
        }
        return Ok(if config.cursor_generation.is_empty() {
            offset
        } else {
            0
        });
    }
    Err(())
}

fn save_offset(data_dir: &Path, config: &Config, offset: i64) -> Result<(), ()> {
    let path = offset_path(data_dir, &config.owner);
    let parent = path.parent().ok_or(())?;
    std::fs::create_dir_all(parent).map_err(|_| ())?;
    let file = tempfile::NamedTempFile::new_in(parent).map_err(|_| ())?;
    if config.cursor_generation.is_empty() {
        std::fs::write(file.path(), offset.to_string()).map_err(|_| ())?;
    } else {
        serde_json::to_writer(
            file.as_file(),
            &PollCursor {
                generation: config.cursor_generation.clone(),
                offset,
            },
        )
        .map_err(|_| ())?;
    }
    file.as_file().sync_all().map_err(|_| ())?;
    file.persist(&path).map_err(|_| ())?;
    Ok(())
}

async fn poll_scope_guard(
    data_dir: &Path,
    expected: &Config,
) -> Option<tokio::sync::OwnedRwLockReadGuard<u64>> {
    let guard = config_gate(data_dir, &expected.owner)?.read_owned().await;
    let current = load_config(data_dir, &expected.owner)?;
    (current.enabled
        && current.owner == expected.owner
        && current.token == expected.token
        && current.scope_generation == expected.scope_generation
        && current.cursor_generation == expected.cursor_generation)
        .then_some(guard)
}

#[derive(Debug, PartialEq)]
enum Inbound {
    Ignore,
    Text {
        chat_id: i64,
        text: String,
    },
    Voice {
        chat_id: i64,
        file_id: String,
        file_size: Option<u64>,
        duration: u64,
        caption: Option<String>,
    },
    Attachment {
        chat_id: i64,
    },
}

fn classify_update(update: &Value) -> Inbound {
    let message = &update["message"];
    let (Some(chat_id), Some("private")) = (
        message["chat"]["id"].as_i64(),
        message["chat"]["type"].as_str(),
    ) else {
        return Inbound::Ignore;
    };
    if let Some(text) = message["text"].as_str() {
        return Inbound::Text {
            chat_id,
            text: text.to_owned(),
        };
    }
    if let Some(file_id) = message["voice"]["file_id"].as_str() {
        return Inbound::Voice {
            chat_id,
            file_id: file_id.to_owned(),
            file_size: message["voice"]["file_size"].as_u64(),
            duration: message["voice"]["duration"].as_u64().unwrap_or(0),
            caption: message["caption"].as_str().map(str::to_owned),
        };
    }
    let has_attachment = ["photo", "document", "voice", "audio", "video", "video_note"]
        .iter()
        .any(|key| !message[*key].is_null());
    if has_attachment {
        Inbound::Attachment { chat_id }
    } else {
        Inbound::Ignore
    }
}

fn bot_id(token: &str) -> Option<&str> {
    let (id, _) = token.split_once(':')?;
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())).then_some(id)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

fn check_pairing<K: Eq + std::hash::Hash>(
    codes: &mut HashMap<K, PairingCode>,
    user_id: &K,
    supplied: &str,
    now: Instant,
) -> bool {
    let Some(entry) = codes.get_mut(user_id) else {
        return false;
    };
    if now.saturating_duration_since(entry.issued) > PAIRING_TTL {
        codes.remove(user_id);
        return false;
    }
    if constant_time_eq(&entry.code, supplied) {
        codes.remove(user_id);
        return true;
    }
    entry.attempts += 1;
    if entry.attempts >= PAIRING_MAX_ATTEMPTS {
        codes.remove(user_id);
    }
    false
}

fn approval_notice(tool_name: &str) -> String {
    format!(
        "Approval needed for {tool_name}. Approve or deny it in the Terminal v4 app; it cannot be approved from Telegram."
    )
}

fn pairing_code(data_dir: &Path, user_id: &str) -> String {
    let code = format!("{:06}", rand_code());
    if let (Some(key), Ok(mut codes)) = (owner_key(data_dir, user_id), PAIRING_CODES.lock()) {
        codes.insert(
            key,
            PairingCode {
                code: code.clone(),
                issued: Instant::now(),
                attempts: 0,
            },
        );
    }
    code
}

fn rand_code() -> u32 {
    let bytes = uuid::Uuid::new_v4();
    u32::from_le_bytes(bytes.as_bytes()[..4].try_into().unwrap_or_default()) % 1_000_000
}

fn status(data_dir: &Path, user_id: &str) -> Value {
    match load_config(data_dir, user_id) {
        None => json!({ "configured": false }),
        Some(config) => json!({
            "configured": true, "botName": config.bot_name, "paired": config.chat_id.is_some(),
            "sessionId": config.session_id, "enabled": config.enabled,
            "pairingCode": config.chat_id.is_none().then(|| PAIRING_CODES.lock().ok().and_then(|codes| codes.get(&owner_key(data_dir, user_id)?).filter(|entry| entry.issued.elapsed() <= PAIRING_TTL).map(|entry| entry.code.clone()))).flatten(),
        }),
    }
}

async fn relay_reply(
    state: AppState,
    config: Config,
    session_id: String,
    token: String,
    chat_id: i64,
    text: String,
) {
    let data_dir = state.config().data_dir.clone();
    if config.session_id.as_deref() != Some(session_id.as_str()) {
        return;
    }
    let Some(guard) = scope_guard(&data_dir, &config, chat_id, true).await else {
        return;
    };
    let manager = state.structured_session_manager();
    let Ok((_, mut events)) = manager.subscribe(&config.owner, &session_id).await else {
        drop(guard);
        send_scoped(
            &data_dir,
            &config,
            &token,
            chat_id,
            "That thread is no longer available. Send /threads to choose another.",
            true,
        )
        .await;
        return;
    };
    if let Err(error) = manager
        .submit(&config.owner, &session_id, &text, None)
        .await
    {
        drop(guard);
        send_scoped(
            &data_dir,
            &config,
            &token,
            chat_id,
            &format!("The thread did not accept the message: {}", error.message),
            true,
        )
        .await;
        return;
    }
    drop(guard);
    let mut reply = String::new();
    let waited = tokio::time::timeout(REPLY_WAIT, async {
        while let Ok(event) = events.recv().await {
            match event {
                StructuredSessionEvent::MessageCompleted { role, content, .. }
                    if role == "assistant" =>
                {
                    reply = content
                }
                StructuredSessionEvent::Error { message, .. } => {
                    reply = format!("Error: {message}")
                }
                StructuredSessionEvent::ApprovalRequired { tool_name, .. } => {
                    if !send_scoped(
                        &data_dir,
                        &config,
                        &token,
                        chat_id,
                        &approval_notice(&tool_name),
                        true,
                    )
                    .await
                    {
                        return;
                    }
                }
                StructuredSessionEvent::InputRequired { .. } => {
                    if !send_scoped(
                        &data_dir,
                        &config,
                        &token,
                        chat_id,
                        "The thread is asking a question. Answer it in the Terminal v4 app.",
                        true,
                    )
                    .await
                    {
                        return;
                    }
                }
                StructuredSessionEvent::TurnCompleted { .. }
                | StructuredSessionEvent::SessionEnded { .. } => break,
                _ => {}
            }
        }
    })
    .await;
    let text = match (waited, reply.trim().is_empty()) {
        (Err(_), _) => {
            "Still working after 30 minutes; check Terminal v4 for the result.".to_owned()
        }
        (Ok(()), true) => "Done (no text reply).".to_owned(),
        (Ok(()), false) => reply,
    };
    send_scoped(&data_dir, &config, &token, chat_id, &text, true).await;
}

const VOICE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const VOICE_MAX_SECONDS: u64 = 120;
const VOICE_TRANSCRIPT_CHARS: usize = 4000;
const VOICE_CAPTION_CHARS: usize = 1024;

struct VoiceNote {
    file_id: String,
    file_size: Option<u64>,
    duration: u64,
    caption: Option<String>,
}

fn voice_prompt(caption: Option<&str>, transcript: &str) -> String {
    let transcript: String = transcript
        .trim()
        .chars()
        .take(VOICE_TRANSCRIPT_CHARS)
        .collect();
    let caption: String = caption
        .unwrap_or("")
        .trim()
        .chars()
        .take(VOICE_CAPTION_CHARS)
        .collect();
    if caption.is_empty() {
        transcript
    } else {
        format!("{caption}\n\nVoice transcript:\n{transcript}")
    }
}

fn safe_file_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && !path.starts_with('/')
        && !path.split('/').any(|part| part.is_empty() || part == "..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
}

async fn download_voice(token: &str, file_id: &str) -> Result<Vec<u8>, &'static str> {
    let file = call(
        token,
        "getFile",
        json!({ "file_id": file_id }),
        Duration::from_secs(15),
    )
    .await
    .map_err(|_| "Telegram would not give me that voice message.")?;
    if file["file_size"]
        .as_u64()
        .is_some_and(|size| size > VOICE_MAX_BYTES)
    {
        return Err("That voice message is too large (limit 2 MB).");
    }
    let path = file["file_path"]
        .as_str()
        .filter(|path| safe_file_path(path))
        .ok_or("Telegram returned an unusable file location.")?;
    let mut response = reqwest::Client::new()
        .get(format!("{}/file/bot{token}/{path}", api_base()))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "The voice message could not be downloaded.")?;
    if !response.status().is_success() {
        return Err("The voice message could not be downloaded.");
    }
    if response
        .content_length()
        .is_some_and(|length| length > VOICE_MAX_BYTES)
    {
        return Err("That voice message is too large (limit 2 MB).");
    }
    let mut audio = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The voice message could not be downloaded.")?
    {
        if (audio.len() + chunk.len()) as u64 > VOICE_MAX_BYTES {
            return Err("That voice message is too large (limit 2 MB).");
        }
        audio.extend_from_slice(&chunk);
    }
    Ok(audio)
}

async fn handle_voice(
    state: AppState,
    config: Config,
    token: String,
    chat_id: i64,
    voice: VoiceNote,
) {
    let data_dir = state.config().data_dir.clone();
    if scope_guard(&data_dir, &config, chat_id, true)
        .await
        .is_none()
    {
        return;
    }
    let Some(session_id) = config.session_id.clone() else {
        send_scoped(
            &data_dir,
            &config,
            &token,
            chat_id,
            "Choose a thread first: /threads, then /use N.",
            true,
        )
        .await;
        return;
    };
    if voice.duration > VOICE_MAX_SECONDS
        || voice.file_size.is_some_and(|size| size > VOICE_MAX_BYTES)
    {
        send_scoped(
            &data_dir,
            &config,
            &token,
            chat_id,
            "That voice message is too long (limit 2 minutes, 2 MB). Send text instead.",
            true,
        )
        .await;
        return;
    }
    let audio = match download_voice(&token, &voice.file_id).await {
        Ok(audio) => audio,
        Err(message) => {
            send_scoped(&data_dir, &config, &token, chat_id, message, true).await;
            return;
        }
    };
    let Some(guard) = scope_guard(&data_dir, &config, chat_id, true).await else {
        return;
    };
    let transcription =
        crate::transcribe::transcribe(audio, "voice.ogg", None, Some("local")).await;
    drop(guard);
    let transcript = match transcription {
        Ok(result) => result
            .text
            .trim()
            .chars()
            .take(VOICE_TRANSCRIPT_CHARS)
            .collect::<String>(),
        Err(_) => {
            send_scoped(
                &data_dir,
                &config,
                &token,
                chat_id,
                "Voice messages need a local Whisper server on this computer; audio is never sent to a cloud service. Send text instead.",
                true,
            )
            .await;
            return;
        }
    };
    if transcript.is_empty() {
        send_scoped(
            &data_dir,
            &config,
            &token,
            chat_id,
            "I could not hear any speech in that voice message.",
            true,
        )
        .await;
        return;
    }
    if !send_scoped(
        &data_dir,
        &config,
        &token,
        chat_id,
        &format!("Heard: {transcript}"),
        true,
    )
    .await
    {
        return;
    }
    let prompt = voice_prompt(voice.caption.as_deref(), &transcript);
    relay_reply(state, config, session_id, token, chat_id, prompt).await;
}

async fn handle(state: &AppState, config: &mut Config, token: &str, chat_id: i64, text: &str) {
    let data_dir = state.config().data_dir.clone();
    let command = parse_command(text);
    if let Command::Use(number) = command {
        let Some(gate) = config_gate(&data_dir, &config.owner) else {
            return;
        };
        let mut guard = gate.write().await;
        let Some(mut current) = load_config(&data_dir, &config.owner) else {
            return;
        };
        if !scope_matches(&current, config, chat_id, false) {
            return;
        }
        let chosen = THREAD_CHOICES.lock().ok().and_then(|choices| {
            choices
                .get(&owner_key(&data_dir, &config.owner)?)?
                .get(number.wrapping_sub(1))
                .cloned()
        });
        let reply = if let Some(id) = chosen {
            current.session_id = Some(id);
            advance_scope(&mut current);
            if save_config(&data_dir, &current).is_err() {
                return;
            }
            *guard = guard.wrapping_add(1);
            *config = current;
            "Thread selected. Messages you send now go to it."
        } else {
            "Send /threads first, then /use with a number from that list."
        };
        drop(guard);
        send_scoped(&data_dir, config, token, chat_id, reply, false).await;
        return;
    }
    let bind_session = matches!(command, Command::Message(_));
    let Some(_guard) = scope_guard(&data_dir, config, chat_id, bind_session).await else {
        return;
    };
    match command {
        Command::Pair(_) | Command::Help => {
            send(
                token,
                chat_id,
                "Send /threads to list your threads, /use N to pick one, then message it here.",
            )
            .await;
        }
        Command::Threads => {
            let mut sessions = state
                .structured_session_manager()
                .list_sessions(&config.owner)
                .await
                .unwrap_or_default();
            sessions.retain(|session| {
                !session
                    .thread
                    .as_ref()
                    .is_some_and(|thread| thread.archived)
            });
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            sessions.truncate(10);
            let ids = sessions.iter().map(|session| session.id.clone()).collect();
            if let (Some(key), Ok(mut choices)) =
                (owner_key(&data_dir, &config.owner), THREAD_CHOICES.lock())
            {
                choices.insert(key, ids);
            }
            let list = sessions
                .iter()
                .enumerate()
                .map(|(index, session)| {
                    format!(
                        "{}. {} ({})",
                        index + 1,
                        if session.title.is_empty() {
                            "Untitled"
                        } else {
                            &session.title
                        },
                        session.provider
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            send(
                token,
                chat_id,
                if list.is_empty() {
                    "No agent threads yet. Start one in Terminal v4."
                } else {
                    &list
                },
            )
            .await;
        }
        Command::Use(_) => unreachable!(),
        Command::Message(text) => match config.session_id.clone() {
            None => {
                send(
                    token,
                    chat_id,
                    "Choose a thread first: /threads, then /use N.",
                )
                .await
            }
            Some(session_id) => {
                tokio::spawn(relay_reply(
                    state.clone(),
                    config.clone(),
                    session_id,
                    token.to_owned(),
                    chat_id,
                    text,
                ));
            }
        },
    }
}

async fn run(state: AppState, user_id: String) {
    let data_dir = state.config().data_dir.clone();
    'worker: loop {
        let mut failures = 0u32;
        let mut reconcile = false;
        let mut failed_generation = None;
        loop {
            let Some(mut config) = load_config(&data_dir, &user_id).filter(|config| config.enabled)
            else {
                reconcile = true;
                break;
            };
            let Ok(token) =
                VaultCipher::load(&data_dir).and_then(|cipher| cipher.decrypt(&config.token))
            else {
                failed_generation = Some(config.scope_generation);
                break;
            };
            let mut offset = match load_offset(&data_dir, &config) {
                Ok(offset) => offset,
                Err(()) => {
                    tracing::warn!("Telegram polling cursor could not be read; retrying");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            let updates = call(
            &token,
            "getUpdates",
            json!({ "offset": offset, "timeout": POLL_SECONDS, "allowed_updates": ["message"] }),
            Duration::from_secs(POLL_SECONDS + 10),
        )
        .await;
            let updates = match updates {
                Ok(updates) => {
                    failures = 0;
                    updates
                }
                Err(error) => {
                    failures += 1;
                    let wait = error
                        .retry_after
                        .map_or_else(|| backoff(failures), |s| Duration::from_secs(s.min(300)));
                    tokio::time::sleep(wait).await;
                    continue;
                }
            };
            for update in updates.as_array().into_iter().flatten() {
                let update_id = update["update_id"].as_i64().unwrap_or(0);
                if update_id < offset {
                    continue;
                }
                let Some(next_offset) = update_id.checked_add(1) else {
                    break;
                };
                let Some(guard) = poll_scope_guard(&data_dir, &config).await else {
                    break;
                };
                if save_offset(&data_dir, &config, next_offset).is_err() {
                    tracing::warn!("Telegram polling cursor could not be saved; retrying");
                    drop(guard);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    break;
                }
                offset = next_offset;
                drop(guard);
                let inbound = classify_update(update);
                let chat_id = match &inbound {
                    Inbound::Text { chat_id, .. }
                    | Inbound::Voice { chat_id, .. }
                    | Inbound::Attachment { chat_id } => *chat_id,
                    Inbound::Ignore => continue,
                };
                if config.chat_id == Some(chat_id) {
                    match inbound {
                        Inbound::Text { text, .. } => {
                            handle(&state, &mut config, &token, chat_id, &text).await
                        }
                        Inbound::Voice {
                            file_id,
                            file_size,
                            duration,
                            caption,
                            ..
                        } => {
                            tokio::spawn(handle_voice(
                                state.clone(),
                                config.clone(),
                                token.clone(),
                                chat_id,
                                VoiceNote {
                                    file_id,
                                    file_size,
                                    duration,
                                    caption,
                                },
                            ));
                        }
                        _ => {
                            send_scoped(
                                &data_dir,
                                &config,
                                &token,
                                chat_id,
                                "Attachments are not forwarded to threads yet. Send text instead.",
                                false,
                            )
                            .await;
                        }
                    }
                } else if config.chat_id.is_none() {
                    let Inbound::Text { text, .. } = inbound else {
                        continue;
                    };
                    let Some(gate) = config_gate(&data_dir, &user_id) else {
                        continue;
                    };
                    let mut guard = gate.write().await;
                    let Some(mut current) = load_config(&data_dir, &user_id) else {
                        continue;
                    };
                    if !current.enabled
                        || current.owner != user_id
                        || current.token != config.token
                        || current.scope_generation != config.scope_generation
                        || current.chat_id.is_some()
                    {
                        continue;
                    }
                    let paired = match parse_command(&text) {
                        Command::Pair(code) => PAIRING_CODES
                            .lock()
                            .map(|mut codes| {
                                owner_key(&data_dir, &user_id).is_some_and(|key| {
                                    check_pairing(&mut codes, &key, &code, Instant::now())
                                })
                            })
                            .unwrap_or(false),
                        _ => false,
                    };
                    if paired {
                        current.chat_id = Some(chat_id);
                        advance_scope(&mut current);
                        if save_config(&data_dir, &current).is_err() {
                            continue;
                        }
                        *guard = guard.wrapping_add(1);
                        config = current;
                        drop(guard);
                        send_scoped(
                            &data_dir,
                            &config,
                            &token,
                            chat_id,
                            "Paired with Terminal v4. Send /threads to choose a thread.",
                            false,
                        )
                        .await;
                    }
                }
            }
        }
        #[cfg(test)]
        pause_worker_exit(&data_dir, &user_id).await;
        let restart = RUNNING.lock().ok().is_some_and(|mut running| {
            let Some(key) = owner_key(&data_dir, &user_id) else {
                return false;
            };
            if load_config(&data_dir, &user_id).is_some_and(|config| {
                config.enabled
                    && (reconcile
                        || failed_generation
                            .as_ref()
                            .is_some_and(|previous| previous != &config.scope_generation))
            }) {
                true
            } else {
                running.remove(&key);
                false
            }
        });
        if !restart {
            break 'worker;
        }
    }
}

fn ensure_worker(state: &AppState, user_id: &str) {
    let started = RUNNING
        .lock()
        .map(|mut running| {
            owner_key(&state.config().data_dir, user_id).is_some_and(|key| running.insert(key))
        })
        .unwrap_or(false);
    if started {
        tokio::spawn(run(state.clone(), user_id.to_owned()));
    }
}

/// Resumes gateways that were enabled before the server restarted.
pub fn start_workers(state: &AppState) {
    let Ok(entries) = std::fs::read_dir(config_dir(&state.config().data_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let config: Option<Config> = std::fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        if let Some(config) = config.filter(|config| config.enabled) {
            ensure_worker(state, &config.owner);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectInput {
    token: String,
}

async fn get_status(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Json<Value> {
    Json(status(&state.config().data_dir, &user.user_id))
}

fn configuration_busy() -> ApiError {
    ApiError {
        status: axum::http::StatusCode::CONFLICT,
        message: "Telegram is busy processing a message. Please retry.".into(),
    }
}

async fn config_write(
    gate: &Arc<ConfigGate>,
) -> Result<tokio::sync::OwnedRwLockWriteGuard<u64>, ApiError> {
    tokio::time::timeout(Duration::from_secs(3), gate.clone().write_owned())
        .await
        .map_err(|_| configuration_busy())
}

#[cfg(test)]
type ExitPause = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);
#[cfg(test)]
static EXIT_PAUSES: LazyLock<Mutex<HashMap<GateKey, ExitPause>>> = LazyLock::new(Default::default);
#[cfg(test)]
static FAIL_CONFIRMATIONS: LazyLock<Mutex<HashSet<GateKey>>> = LazyLock::new(Default::default);
#[cfg(test)]
async fn pause_worker_exit(data_dir: &Path, owner: &str) {
    let pause = owner_key(data_dir, owner).and_then(|key| EXIT_PAUSES.lock().ok()?.remove(&key));
    if let Some((entered, release)) = pause {
        let _ = entered.send(());
        let _ = release.await;
    }
}
#[cfg(test)]
fn take_failed_confirmation(data_dir: &Path, owner: &str) -> bool {
    owner_key(data_dir, owner).is_some_and(|key| {
        FAIL_CONFIRMATIONS
            .lock()
            .map(|mut failures| failures.remove(&key))
            .unwrap_or(false)
    })
}

fn commit_with_authority<T>(
    state: &AppState,
    owner: &str,
    authority: Option<Extension<LocalAuthority>>,
    action: impl FnOnce() -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let authority = authority.ok_or_else(|| ApiError {
        status: axum::http::StatusCode::UNAUTHORIZED,
        message: "Local authentication is required".into(),
    })?;
    #[cfg(unix)]
    {
        let result = state.try_with_owner_review(owner, &authority.0, |tx, check| {
            check()?;
            let result = action();
            #[cfg(test)]
            if take_failed_confirmation(&state.config().data_dir, owner) {
                tx.execute_batch("ROLLBACK")
                    .map_err(|_| "Test rollback failed")?;
            }
            #[cfg(not(test))]
            let _ = tx;
            Ok(result)
        });
        match result {
            Ok(value) => value,
            Err(error) if error == "Credential is invalid or expired" || error == "Credential has been revoked" => Err(ApiError { status: axum::http::StatusCode::UNAUTHORIZED, message: "Authentication expired or was revoked".into() }),
            Err(error) if error == "Owner review outcome is uncertain" => Err(ApiError::internal("Telegram settings may have changed, but authentication confirmation failed; refresh before retrying")),
            Err(_) => Err(ApiError { status: axum::http::StatusCode::SERVICE_UNAVAILABLE, message: "Telegram authorization is busy or unavailable; retry".into() }),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (state, owner, authority, action);
        Err(ApiError::internal(
            "Telegram configuration changes are unavailable on this platform",
        ))
    }
}

async fn connect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<LocalAuthority>>,
    Json(input): Json<ConnectInput>,
) -> Result<Json<Value>, ApiError> {
    let token = input.token.trim();
    if token.is_empty()
        || token.len() > 200
        || !token.contains(':')
        || token.chars().any(char::is_whitespace)
    {
        return Err(ApiError::bad_request("Paste the bot token from @BotFather"));
    }
    let data_dir = state.config().data_dir.clone();
    let gate = config_gate(&data_dir, &user.user_id)
        .ok_or_else(|| ApiError::internal("Telegram configuration is unavailable"))?;
    let revision = *tokio::time::timeout(Duration::from_secs(3), gate.read())
        .await
        .map_err(|_| configuration_busy())?;
    let me = call(token, "getMe", json!({}), Duration::from_secs(15))
        .await
        .map_err(|error| ApiError::bad_request(error.message))?;
    let cipher = VaultCipher::load(&data_dir).map_err(ApiError::internal)?;
    let mut guard = config_write(&gate).await?;
    if *guard != revision {
        return Err(ApiError {
            status: axum::http::StatusCode::CONFLICT,
            message: "Telegram settings changed while connecting; please retry".into(),
        });
    }
    *guard = guard.wrapping_add(1);
    commit_with_authority(&state, &user.user_id, authority, || {
        let cursor_generation = load_config(&data_dir, &user.user_id)
            .and_then(|previous| {
                let old_token = cipher.decrypt(&previous.token).ok()?;
                (bot_id(&old_token).is_some() && bot_id(&old_token) == bot_id(token))
                    .then_some(previous.cursor_generation)
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        save_config(
            &data_dir,
            &Config {
                owner: user.user_id.clone(),
                token: cipher.encrypt(token).map_err(ApiError::internal)?,
                bot_name: me["username"].as_str().unwrap_or("your bot").to_owned(),
                chat_id: None,
                session_id: None,
                enabled: true,
                scope_generation: uuid::Uuid::new_v4().to_string(),
                cursor_generation,
            },
        )
    })?;
    pairing_code(&data_dir, &user.user_id);
    ensure_worker(&state, &user.user_id);
    Ok(Json(status(&data_dir, &user.user_id)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    enabled: Option<bool>,
    new_pairing_code: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<LocalAuthority>>,
    Json(input): Json<UpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let data_dir = state.config().data_dir.clone();
    let gate = config_gate(&data_dir, &user.user_id)
        .ok_or_else(|| ApiError::internal("Telegram configuration is unavailable"))?;
    let mut guard = config_write(&gate).await?;
    *guard = guard.wrapping_add(1);
    let config = commit_with_authority(&state, &user.user_id, authority, || {
        let mut config = load_config(&data_dir, &user.user_id)
            .ok_or_else(|| ApiError::not_found("Telegram is not connected"))?;
        if let Some(enabled) = input.enabled {
            config.enabled = enabled;
        }
        if input.new_pairing_code == Some(true) {
            config.chat_id = None;
        }
        advance_scope(&mut config);
        save_config(&data_dir, &config)?;
        Ok(config)
    })?;
    if input.new_pairing_code == Some(true) {
        pairing_code(&data_dir, &user.user_id);
    }
    if config.enabled {
        ensure_worker(&state, &user.user_id);
    }
    Ok(Json(status(&data_dir, &user.user_id)))
}

fn remove_if_present(path: &Path) -> Result<(), ApiError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ApiError::internal(
            "Unable to remove Telegram settings; retry disconnect",
        )),
    }
}

async fn disconnect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<LocalAuthority>>,
) -> Result<Json<Value>, ApiError> {
    let data_dir = state.config().data_dir.clone();
    let gate = config_gate(&data_dir, &user.user_id)
        .ok_or_else(|| ApiError::internal("Telegram configuration is unavailable"))?;
    let mut guard = config_write(&gate).await?;
    *guard = guard.wrapping_add(1);
    commit_with_authority(&state, &user.user_id, authority, || {
        remove_if_present(&config_path(&data_dir, &user.user_id))
    })?;
    if let Ok(mut codes) = PAIRING_CODES.lock() {
        if let Some(key) = owner_key(&data_dir, &user.user_id) {
            codes.remove(&key);
        }
    }
    remove_if_present(&offset_path(&data_dir, &user.user_id))?;
    Ok(Json(status(&data_dir, &user.user_id)))
}

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/messaging/telegram",
        get(get_status)
            .put(connect)
            .patch(update)
            .delete(disconnect),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn reads_bot_commands_and_plain_messages() {
        assert_eq!(
            [
                "/pair 123456",
                "/threads@my_bot",
                "/use 2",
                "/use two",
                "Fix the login bug"
            ]
            .map(parse_command),
            [
                Command::Pair("123456".into()),
                Command::Threads,
                Command::Use(2),
                Command::Help,
                Command::Message("Fix the login bug".into()),
            ]
        );
    }

    #[test]
    fn splits_long_replies_for_telegram() {
        let long = format!("{}\n{}", "a".repeat(3000), "b".repeat(3000));
        let parts = chunks(&long);
        assert_eq!(
            (
                parts.len(),
                parts
                    .iter()
                    .all(|part| part.chars().count() <= MESSAGE_LIMIT),
                parts.concat() == long
            ),
            (2, true, true)
        );
    }

    #[test]
    fn settings_are_kept_per_user_with_the_token_encrypted() {
        let data = tempfile::tempdir().unwrap();
        let cipher = VaultCipher::load(data.path()).unwrap();
        let config = Config {
            owner: "owner".into(),
            token: cipher.encrypt("123:secret").unwrap(),
            bot_name: "my_bot".into(),
            enabled: true,
            ..Default::default()
        };
        save_config(data.path(), &config).unwrap();
        let stored = std::fs::read_to_string(config_path(data.path(), "owner")).unwrap();
        assert_eq!(
            (
                stored.contains("123:secret"),
                cipher
                    .decrypt(&load_config(data.path(), "owner").unwrap().token)
                    .unwrap(),
                load_config(data.path(), "someone-else").is_none(),
                status(data.path(), "owner")["botName"].clone(),
            ),
            (false, "123:secret".to_owned(), true, json!("my_bot"))
        );
    }

    fn update(chat_type: &str, extra: Value) -> Value {
        let mut message = json!({ "chat": { "id": 7, "type": chat_type } });
        message
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({ "update_id": 1, "message": message })
    }

    #[test]
    fn classifies_only_private_chat_updates() {
        assert_eq!(
            [
                classify_update(&update("private", json!({ "text": "hi" }))),
                classify_update(&update("group", json!({ "text": "hi" }))),
                classify_update(&update("private", json!({ "photo": [{}] }))),
                classify_update(&update("private", json!({ "sticker": {} }))),
                classify_update(&json!({ "update_id": 2, "edited_message": {} })),
            ],
            [
                Inbound::Text {
                    chat_id: 7,
                    text: "hi".into()
                },
                Inbound::Ignore,
                Inbound::Attachment { chat_id: 7 },
                Inbound::Ignore,
                Inbound::Ignore,
            ]
        );
    }

    fn code_for<'a>(user: &'a str, code: &str, issued: Instant) -> HashMap<&'a str, PairingCode> {
        HashMap::from([(
            user,
            PairingCode {
                code: code.to_owned(),
                issued,
                attempts: 0,
            },
        )])
    }

    #[test]
    fn pairing_code_is_single_use() {
        let now = Instant::now();
        let mut codes = code_for("u", "123456", now);
        assert_eq!(
            (
                check_pairing(&mut codes, &"u", "123456", now),
                check_pairing(&mut codes, &"u", "123456", now)
            ),
            (true, false)
        );
    }

    #[test]
    fn pairing_code_expires() {
        let issued = Instant::now();
        let mut codes = code_for("u", "123456", issued);
        let late = issued + PAIRING_TTL + Duration::from_secs(1);
        assert_eq!(
            (check_pairing(&mut codes, &"u", "123456", late), codes.len()),
            (false, 0)
        );
    }

    #[test]
    fn pairing_code_is_burned_after_too_many_wrong_guesses() {
        let now = Instant::now();
        let mut codes = code_for("u", "123456", now);
        for guess in 0..PAIRING_MAX_ATTEMPTS {
            assert!(!check_pairing(
                &mut codes,
                &"u",
                &format!("00000{guess}"),
                now
            ));
        }
        assert_eq!(
            (check_pairing(&mut codes, &"u", "123456", now), codes.len()),
            (false, 0)
        );
    }

    #[test]
    fn pairing_rejects_unknown_user_and_length_mismatch() {
        let now = Instant::now();
        let mut codes = code_for("u", "123456", now);
        assert_eq!(
            (
                check_pairing(&mut codes, &"other", "123456", now),
                check_pairing(&mut codes, &"u", "12345", now),
                check_pairing(&mut codes, &"u", "", now),
            ),
            (false, false, false)
        );
    }

    #[test]
    fn offset_survives_restart_and_corruption_fails_closed() {
        let data = tempfile::tempdir().unwrap();
        let config = Config {
            owner: "u".into(),
            cursor_generation: "generation-a".into(),
            ..Default::default()
        };
        assert_eq!(load_offset(data.path(), &config), Ok(0));
        save_offset(data.path(), &config, 42).unwrap();
        let restored = load_offset(data.path(), &config);
        let replacement = Config {
            cursor_generation: "generation-b".into(),
            ..config.clone()
        };
        let new_bot = load_offset(data.path(), &replacement);
        std::fs::write(offset_path(data.path(), "u"), "junk").unwrap();
        assert_eq!(
            (restored, new_bot, load_offset(data.path(), &config)),
            (Ok(42), Ok(0), Err(()))
        );
    }

    #[test]
    fn legacy_numeric_offset_is_preserved_only_for_legacy_config() {
        let data = tempfile::tempdir().unwrap();
        let legacy = Config {
            owner: "u".into(),
            ..Default::default()
        };
        std::fs::create_dir_all(config_dir(data.path())).unwrap();
        std::fs::write(offset_path(data.path(), "u"), "42").unwrap();
        let new_bot = Config {
            cursor_generation: "new-bot".into(),
            ..legacy.clone()
        };
        assert_eq!(
            (
                load_offset(data.path(), &legacy),
                load_offset(data.path(), &new_bot)
            ),
            (Ok(42), Ok(0))
        );
        save_offset(data.path(), &legacy, 43).unwrap();
        assert_eq!(load_offset(data.path(), &legacy), Ok(43));
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(
            [0, 1, 2, 3, 10, 40].map(|n| backoff(n).as_secs()),
            [2, 2, 4, 8, 60, 60]
        );
    }

    #[test]
    fn approval_notice_points_to_the_app_and_leaks_no_input() {
        let notice = approval_notice("bash");
        assert_eq!(
            (
                notice.contains("bash"),
                notice.contains("Terminal v4 app"),
                notice.contains("cannot be approved from Telegram")
            ),
            (true, true, true)
        );
    }

    #[test]
    fn chunking_handles_edges() {
        let exact = "a".repeat(MESSAGE_LIMIT);
        let over = "é".repeat(MESSAGE_LIMIT + 1);
        let lines = format!("{}\n{}\n", "x".repeat(MESSAGE_LIMIT - 1), "y");
        assert_eq!(
            (
                chunks("").len(),
                chunks("  \n").len(),
                chunks(&exact).len(),
                chunks(&over)
                    .iter()
                    .map(|p| p.chars().count())
                    .collect::<Vec<_>>(),
                chunks(&lines).len(),
            ),
            (0, 0, 1, vec![MESSAGE_LIMIT, 1], 2)
        );
    }

    #[tokio::test]
    async fn retries_rate_limited_sends_and_reads_retry_after() {
        use axum::{http::StatusCode, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let _env = ENV_LOCK.lock().await;
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let app = Router::new().route(
            "/botT/sendMessage",
            post(move || {
                let seen = seen.clone();
                async move {
                    if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            Json(json!({ "ok": false, "description": "slow down", "parameters": { "retry_after": 0 } })),
                        )
                    } else {
                        (StatusCode::OK, Json(json!({ "ok": true, "result": {} })))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        let failed = call("T", "sendMessage", json!({}), Duration::from_secs(5)).await;
        let retry_after = failed.err().and_then(|error| error.retry_after);
        hits.store(0, Ordering::SeqCst);
        let delivered = send_part("T", 1, "hello").await;
        std::env::remove_var("TELEGRAM_API_BASE");
        assert_eq!(
            (retry_after, delivered, hits.load(Ordering::SeqCst)),
            (Some(0), true, 2)
        );
    }

    type Sent = std::sync::Arc<Mutex<Vec<Value>>>;

    async fn mock_telegram(
        fail_sends: bool,
        voice_bytes: Vec<u8>,
        advertised_size: u64,
    ) -> (Sent, u16) {
        use axum::{extract::Path as UrlPath, http::StatusCode, routing::post};
        let sent: Sent = Default::default();
        let log = sent.clone();
        let app = Router::new()
            .route(
                "/bot{token}/sendMessage",
                post(move |UrlPath(token): UrlPath<String>, Json(body): Json<Value>| {
                    let log = log.clone();
                    async move {
                        log.lock().unwrap().push(json!({ "token": token, "body": body }));
                        if fail_sends {
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({ "ok": false, "description": "chat not found" })),
                            )
                        } else {
                            (StatusCode::OK, Json(json!({ "ok": true, "result": {} })))
                        }
                    }
                }),
            )
            .route(
                "/bot{token}/getFile",
                post(move |Json(body): Json<Value>| async move {
                    let path = match body["file_id"].as_str() {
                        Some("evil") => "../secret",
                        _ => "voice/file_1.oga",
                    };
                    Json(json!({ "ok": true, "result": { "file_path": path, "file_size": advertised_size } }))
                }),
            )
            .route(
                "/file/bot{token}/voice/file_1.oga",
                axum::routing::get(move || {
                    let bytes = voice_bytes.clone();
                    async move { bytes }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (sent, port)
    }

    #[tokio::test]
    async fn owner_send_reaches_only_the_paired_chat_in_bounded_chunks() {
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let (sent, port) = mock_telegram(false, vec![], 0).await;
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        seed_paired_for_test(data.path(), "alice", "111:alice-secret", Some(42), true);
        seed_paired_for_test(data.path(), "bob", "222:bob-secret", Some(77), true);
        let text = format!("{}\n{}", "a".repeat(3000), "b".repeat(20_000));
        let result = send_to_owner(data.path(), "alice", &text).await;
        std::env::remove_var("TELEGRAM_API_BASE");
        let log = sent.lock().unwrap();
        let total: usize = log
            .iter()
            .map(|entry| entry["body"]["text"].as_str().unwrap().chars().count())
            .sum();
        assert_eq!(
            (
                result,
                log.iter()
                    .map(|entry| entry["token"].to_string())
                    .collect::<std::collections::BTreeSet<_>>(),
                log.iter()
                    .map(|entry| entry["body"]["chat_id"].to_string())
                    .collect::<std::collections::BTreeSet<_>>(),
                log.iter().all(
                    |entry| entry["body"]["text"].as_str().unwrap().chars().count()
                        <= MESSAGE_LIMIT
                ),
                total <= OWNER_SEND_CHARS + "\n[truncated]".len(),
                log.last().unwrap()["body"]["text"]
                    .as_str()
                    .unwrap()
                    .ends_with("[truncated]"),
            ),
            (
                Ok(()),
                ["\"111:alice-secret\"".to_owned()].into(),
                ["42".to_owned()].into(),
                true,
                true,
                true
            )
        );
    }

    #[tokio::test]
    async fn owner_send_does_not_retry_an_unreadable_reply_after_delivery() {
        use axum::{extract::Path as UrlPath, routing::post};
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let sent: Sent = Default::default();
        let log = sent.clone();
        let app = Router::new().route(
            "/bot{token}/sendMessage",
            post(
                move |UrlPath(token): UrlPath<String>, Json(body): Json<Value>| {
                    let log = log.clone();
                    async move {
                        log.lock()
                            .unwrap()
                            .push(json!({ "token": token, "body": body }));
                        "not a Telegram response"
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let result = send_to_owner(data.path(), "alice", "A scheduled result").await;
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
        assert_eq!(
            (
                sent.lock().unwrap().len(),
                result.is_err(),
                result.unwrap_err().reason().contains("may have been sent"),
            ),
            (1, true, true)
        );
    }

    #[tokio::test]
    async fn owner_send_does_not_follow_a_redirect_after_delivery() {
        use axum::{
            extract::Path as UrlPath,
            http::{header, StatusCode},
            routing::post,
        };
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let sent: Sent = Default::default();
        let first = sent.clone();
        let redirected = sent.clone();
        let app = Router::new()
            .route(
                "/bot{token}/sendMessage",
                post(
                    move |UrlPath(token): UrlPath<String>, Json(body): Json<Value>| {
                        let first = first.clone();
                        async move {
                            first
                                .lock()
                                .unwrap()
                                .push(json!({ "token": token, "body": body }));
                            (
                                StatusCode::TEMPORARY_REDIRECT,
                                [(header::LOCATION, "/redirected")],
                            )
                        }
                    },
                ),
            )
            .route(
                "/redirected",
                post(move |Json(body): Json<Value>| {
                    let redirected = redirected.clone();
                    async move {
                        redirected.lock().unwrap().push(json!({ "body": body }));
                        Json(json!({ "ok": true, "result": {} }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let result = send_to_owner(data.path(), "alice", "A scheduled result").await;
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
        assert_eq!((sent.lock().unwrap().len(), result.is_err()), (1, true));
    }

    #[tokio::test]
    async fn owner_send_refuses_without_a_paired_enabled_owner_and_never_leaks_the_token() {
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let (sent, port) = mock_telegram(true, vec![], 0).await;
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        seed_paired_for_test(data.path(), "unpaired", "1:tok", None, true);
        seed_paired_for_test(data.path(), "off", "2:tok", Some(5), false);
        seed_paired_for_test(data.path(), "rejected", "3:topsecret", Some(6), true);
        let results = [
            send_to_owner(data.path(), "nobody", "x").await,
            send_to_owner(data.path(), "unpaired", "x").await,
            send_to_owner(data.path(), "off", "x").await,
            send_to_owner(data.path(), "rejected", "x").await,
        ];
        std::env::remove_var("TELEGRAM_API_BASE");
        let reasons: Vec<_> = results
            .iter()
            .map(|result| result.unwrap_err().reason())
            .collect();
        assert_eq!(
            (
                results,
                sent.lock().unwrap().len(),
                reasons.iter().any(|reason| reason.contains("topsecret")),
                reasons.iter().map(|_| ()).count(),
            ),
            (
                [
                    Err(OwnerSendError::NotConnected),
                    Err(OwnerSendError::NotPaired),
                    Err(OwnerSendError::Disabled),
                    Err(OwnerSendError::Rejected)
                ],
                1,
                false,
                4
            )
        );
    }

    #[test]
    fn classifies_voice_messages_with_their_limits() {
        assert_eq!(
            classify_update(&update(
                "private",
                json!({ "voice": { "file_id": "abc", "file_size": 1234, "duration": 5 } })
            )),
            Inbound::Voice {
                chat_id: 7,
                file_id: "abc".into(),
                file_size: Some(1234),
                duration: 5,
                caption: None,
            }
        );
    }

    #[test]
    fn voice_caption_is_preserved_with_the_transcript() {
        let inbound = classify_update(&update(
            "private",
            json!({
                "voice": { "file_id": "abc", "file_size": 1234, "duration": 5 },
                "caption": "  Please summarize this  "
            }),
        ));
        let Inbound::Voice { caption, .. } = inbound else {
            panic!("expected voice update");
        };
        assert_eq!(
            (
                caption.as_deref(),
                voice_prompt(caption.as_deref(), "  Meeting starts at noon.  "),
                voice_prompt(Some("  "), "hello"),
                voice_prompt(None, "hello"),
            ),
            (
                Some("  Please summarize this  "),
                "Please summarize this\n\nVoice transcript:\nMeeting starts at noon.".to_owned(),
                "hello".to_owned(),
                "hello".to_owned(),
            )
        );
    }

    #[test]
    fn voice_caption_and_transcript_are_bounded_by_characters() {
        let caption = "é".repeat(1500);
        let transcript = "🦀".repeat(5000);
        let prompt = voice_prompt(Some(&caption), &transcript);
        let (actual_caption, actual_transcript) =
            prompt.split_once("\n\nVoice transcript:\n").unwrap();
        assert_eq!(
            (
                actual_caption.chars().count(),
                actual_transcript.chars().count()
            ),
            (1024, 4000)
        );
    }

    #[test]
    fn telegram_file_paths_cannot_escape_the_file_endpoint() {
        assert_eq!(
            [
                "voice/file_1.oga",
                "../secret",
                "/etc/passwd",
                "a//b",
                "a b",
                ""
            ]
            .map(safe_file_path),
            [true, false, false, false, false, false]
        );
    }

    #[tokio::test]
    async fn voice_download_is_size_bounded_by_metadata_and_by_body() {
        let _env = ENV_LOCK.lock().await;
        let small = vec![7u8; 1000];
        let (_, port) = mock_telegram(false, small.clone(), 1000).await;
        let (_, lying) = mock_telegram(false, vec![0u8; (VOICE_MAX_BYTES + 1) as usize], 10).await;
        let (_, big) = mock_telegram(false, small.clone(), VOICE_MAX_BYTES + 1).await;
        let fetch = |port: u16, id: &'static str| async move {
            std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
            download_voice("T", id).await
        };
        let results = (
            fetch(port, "ok").await,
            fetch(lying, "ok").await,
            fetch(big, "ok").await,
            fetch(port, "evil").await,
        );
        std::env::remove_var("TELEGRAM_API_BASE");
        assert_eq!(
            results,
            (
                Ok(small),
                Err("That voice message is too large (limit 2 MB)."),
                Err("That voice message is too large (limit 2 MB)."),
                Err("Telegram returned an unusable file location.")
            )
        );
    }

    #[tokio::test]
    async fn in_flight_voice_does_not_reply_after_gateway_or_thread_changes() {
        use axum::routing::post;
        use std::sync::Arc;
        use tokio::sync::Notify;

        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        let (sent, port) = mock_telegram(false, vec![7; 1000], 1000).await;
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));

        let mut counts = Vec::new();
        for change in ["disable", "unpair", "switch", "disconnect"] {
            seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
            let mut original = load_config(data.path(), "alice").unwrap();
            original.session_id = Some("ss-original".into());
            save_config(data.path(), &original).unwrap();

            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let (started_handler, release_handler) = (started.clone(), release.clone());
            let app = Router::new().route(
                "/inference",
                post(move || {
                    let (started, release) = (started_handler.clone(), release_handler.clone());
                    async move {
                        started.notify_one();
                        release.notified().await;
                        Json(json!({ "text": "synthetic voice transcript" }))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let whisper_port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            std::env::set_var(
                "WHISPER_SERVER_URL",
                format!("http://127.0.0.1:{whisper_port}"),
            );
            let worker = tokio::spawn(handle_voice(
                state.clone(),
                original.clone(),
                "111:synthetic".into(),
                42,
                VoiceNote {
                    file_id: "ok".into(),
                    file_size: Some(1000),
                    duration: 1,
                    caption: None,
                },
            ));
            tokio::time::timeout(Duration::from_secs(5), started.notified())
                .await
                .unwrap();
            let mut changed = original;
            match change {
                "disable" => changed.enabled = false,
                "unpair" => changed.chat_id = None,
                "switch" => changed.session_id = Some("ss-other".into()),
                _ => {}
            }
            if change == "disconnect" {
                std::fs::remove_file(config_path(data.path(), "alice")).unwrap();
            } else {
                save_config(data.path(), &changed).unwrap();
            }
            let before = sent.lock().unwrap().len();
            release.notify_one();
            tokio::time::timeout(Duration::from_secs(5), worker)
                .await
                .unwrap()
                .unwrap();
            counts.push(sent.lock().unwrap().len() - before);
            server.abort();
        }
        std::env::remove_var("WHISPER_SERVER_URL");
        std::env::remove_var("TELEGRAM_API_BASE");
        assert_eq!(counts, [0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn disable_waits_for_an_admitted_send_without_blocking_another_owner() {
        use axum::routing::post;
        use std::sync::Arc;
        use tokio::sync::Notify;

        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        seed_paired_for_test(data.path(), "bob", "222:synthetic", Some(43), true);
        let original = load_config(data.path(), "alice").unwrap();

        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (started_handler, release_handler) = (started.clone(), release.clone());
        let app = Router::new().route(
            "/bot{token}/sendMessage",
            post(move || {
                let (started, release) = (started_handler.clone(), release_handler.clone());
                async move {
                    started.notify_one();
                    release.notified().await;
                    Json(json!({ "ok": true, "result": {} }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));

        let send_data = data.path().to_path_buf();
        let sender = tokio::spawn(async move { send_to_owner(&send_data, "alice", "hello").await });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        let disable_state = state.clone();
        let mut disable_alice = tokio::spawn(async move {
            super::update(
                State(disable_state),
                Extension(AuthenticatedUser {
                    user_id: "alice".into(),
                    username: "alice".into(),
                }),
                Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                Json(UpdateInput {
                    enabled: Some(false),
                    new_pairing_code: None,
                }),
            )
            .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut disable_alice)
                .await
                .is_err()
        );
        let bob = tokio::time::timeout(
            Duration::from_secs(2),
            super::update(
                State(state),
                Extension(AuthenticatedUser {
                    user_id: "bob".into(),
                    username: "bob".into(),
                }),
                Some(Extension(LocalAuthority::for_test("bob", 0, i64::MAX))),
                Json(UpdateInput {
                    enabled: Some(false),
                    new_pairing_code: None,
                }),
            ),
        )
        .await
        .unwrap();
        assert!(bob.is_ok());
        release.notify_one();
        assert_eq!(sender.await.unwrap(), Ok(()));
        assert!(disable_alice.await.unwrap().is_ok());
        assert!(scope_guard(data.path(), &original, 42, true)
            .await
            .is_none());

        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
    }

    #[tokio::test]
    async fn changed_scope_cannot_be_revived_by_restoring_old_values() {
        let data = tempfile::tempdir().unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let mut original = load_config(data.path(), "alice").unwrap();
        original.session_id = Some("ss-one".into());
        save_config(data.path(), &original).unwrap();
        assert!(scope_guard(data.path(), &original, 42, true)
            .await
            .is_some());

        let mut changed = original.clone();
        changed.enabled = false;
        advance_scope(&mut changed);
        save_config(data.path(), &changed).unwrap();
        changed.enabled = true;
        advance_scope(&mut changed);
        save_config(data.path(), &changed).unwrap();
        let after_reenable = scope_guard(data.path(), &original, 42, true)
            .await
            .is_none();

        let prior_thread = changed.clone();
        changed.session_id = Some("ss-two".into());
        advance_scope(&mut changed);
        save_config(data.path(), &changed).unwrap();
        changed.session_id = Some("ss-one".into());
        advance_scope(&mut changed);
        save_config(data.path(), &changed).unwrap();
        let after_thread_return = scope_guard(data.path(), &prior_thread, 42, true)
            .await
            .is_none();
        assert_eq!((after_reenable, after_thread_return), (true, true));
    }

    #[tokio::test]
    async fn stale_thread_selection_cannot_reenable_a_disabled_gateway() {
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        let (sent, port) = mock_telegram(false, vec![], 0).await;
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let mut stale = load_config(data.path(), "alice").unwrap();
        stale.session_id = Some("ss-first".into());
        save_config(data.path(), &stale).unwrap();
        THREAD_CHOICES.lock().unwrap().insert(
            owner_key(data.path(), "alice").unwrap(),
            vec!["ss-second".into()],
        );
        let mut disabled = stale.clone();
        disabled.enabled = false;
        advance_scope(&mut disabled);
        save_config(data.path(), &disabled).unwrap();

        handle(&state, &mut stale, "111:synthetic", 42, "/use 1").await;
        let persisted = load_config(data.path(), "alice").unwrap();
        let sent_count = sent.lock().unwrap().len();
        THREAD_CHOICES
            .lock()
            .unwrap()
            .remove(&owner_key(data.path(), "alice").unwrap());
        std::env::remove_var("TELEGRAM_API_BASE");
        assert_eq!(
            (
                persisted.enabled,
                persisted.session_id.as_deref(),
                sent_count
            ),
            (false, Some("ss-first"), 0)
        );
    }
    #[test]
    fn pairing_state_is_isolated_between_data_directories() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        seed_paired_for_test(first.path(), "alice", "111:synthetic", None, true);
        seed_paired_for_test(second.path(), "alice", "222:synthetic", None, true);
        let first_key = owner_key(first.path(), "alice").unwrap();
        let second_key = owner_key(second.path(), "alice").unwrap();
        let now = Instant::now();
        {
            let mut codes = PAIRING_CODES.lock().unwrap();
            codes.insert(
                first_key.clone(),
                PairingCode {
                    code: "111111".into(),
                    issued: now,
                    attempts: 0,
                },
            );
            codes.insert(
                second_key.clone(),
                PairingCode {
                    code: "222222".into(),
                    issued: now,
                    attempts: 0,
                },
            );
        }
        assert_eq!(
            (
                status(first.path(), "alice")["pairingCode"].clone(),
                status(second.path(), "alice")["pairingCode"].clone()
            ),
            (json!("111111"), json!("222222"))
        );
        let mut codes = PAIRING_CODES.lock().unwrap();
        assert!(check_pairing(&mut codes, &first_key, "111111", now));
        assert!(check_pairing(&mut codes, &second_key, "222222", now));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delayed_connect_cannot_restore_after_disconnect_or_logout() {
        use axum::routing::post;
        use tokio::sync::Notify;
        let _env = ENV_LOCK.lock().await;
        for change in ["disconnect", "logout"] {
            let data = tempfile::tempdir().unwrap();
            let state = AppState::new(terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "synthetic-telegram-test-secret".into(),
                ..Default::default()
            })
            .unwrap();
            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let (started_handler, release_handler) = (started.clone(), release.clone());
            let app = Router::new().route(
                "/bot{token}/getMe",
                post(move || {
                    let (started, release) = (started_handler.clone(), release_handler.clone());
                    async move {
                        started.notify_one();
                        release.notified().await;
                        Json(json!({ "ok": true, "result": { "username": "synthetic" } }))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
            let connecting_state = state.clone();
            let connecting = tokio::spawn(async move {
                super::connect(
                    State(connecting_state),
                    Extension(AuthenticatedUser {
                        user_id: "alice".into(),
                        username: "alice".into(),
                    }),
                    Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                    Json(ConnectInput {
                        token: "111:synthetic".into(),
                    }),
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), started.notified())
                .await
                .unwrap();
            if change == "disconnect" {
                let _ = super::disconnect(
                    State(state.clone()),
                    Extension(AuthenticatedUser {
                        user_id: "alice".into(),
                        username: "alice".into(),
                    }),
                    Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                )
                .await
                .unwrap();
            } else {
                state.logout_user("alice").unwrap();
            }
            release.notify_one();
            let error = connecting.await.unwrap().unwrap_err();
            assert_eq!(
                error.status,
                if change == "disconnect" {
                    axum::http::StatusCode::CONFLICT
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            );
            assert!(load_config(data.path(), "alice").is_none());
            server.abort();
        }
        std::env::remove_var("TELEGRAM_API_BASE");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn waiting_update_revalidates_logout_and_times_out_while_busy() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let gate = config_gate(data.path(), "alice").unwrap();
        let guard = gate.clone().read_owned().await;
        let update_state = state.clone();
        let waiting = tokio::spawn(async move {
            super::update(
                State(update_state),
                Extension(AuthenticatedUser {
                    user_id: "alice".into(),
                    username: "alice".into(),
                }),
                Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                Json(UpdateInput {
                    enabled: Some(false),
                    new_pairing_code: None,
                }),
            )
            .await
        });
        tokio::task::yield_now().await;
        state.logout_user("alice").unwrap();
        drop(guard);
        assert_eq!(
            waiting.await.unwrap().unwrap_err().status,
            axum::http::StatusCode::UNAUTHORIZED
        );
        assert!(load_config(data.path(), "alice").unwrap().enabled);

        let _guard = gate.read().await;
        let busy = super::update(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }),
            Some(Extension(LocalAuthority::for_test("alice", 1, i64::MAX))),
            Json(UpdateInput {
                enabled: Some(false),
                new_pairing_code: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(busy.status, axum::http::StatusCode::CONFLICT);
        assert!(load_config(data.path(), "alice").unwrap().enabled);
    }

    #[test]
    fn disconnect_failure_is_not_reported_as_success() {
        let data = tempfile::tempdir().unwrap();
        let directory = data.path().join("cannot-remove-as-file");
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(
            remove_if_present(&directory).unwrap_err().status,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(directory.is_dir());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stale_pairing_poll_cannot_pair_after_disable_and_reenable() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::Notify;

        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", None, true);
        let code = pairing_code(data.path(), "alice");
        let key = owner_key(data.path(), "alice").unwrap();
        RUNNING.lock().unwrap().insert(key.clone());
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let polled_again = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route("/bot{token}/getUpdates", post({
            let (started, release, polled_again, calls) = (started.clone(), release.clone(), polled_again.clone(), calls.clone());
            move || {
                let (started, release, polled_again, calls, code) = (started.clone(), release.clone(), polled_again.clone(), calls.clone(), code.clone());
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        started.notify_one();
                        release.notified().await;
                        Json(json!({ "ok": true, "result": [{ "update_id": 1, "message": { "chat": { "id": 42, "type": "private" }, "text": format!("/pair {code}") } }] }))
                    } else {
                        polled_again.notify_one();
                        std::future::pending::<Json<Value>>().await
                    }
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        let worker = tokio::spawn(run(state.clone(), "alice".into()));
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        for enabled in [false, true] {
            let _ = super::update(
                State(state.clone()),
                Extension(AuthenticatedUser {
                    user_id: "alice".into(),
                    username: "alice".into(),
                }),
                Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                Json(UpdateInput {
                    enabled: Some(enabled),
                    new_pairing_code: None,
                }),
            )
            .await
            .unwrap();
        }
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), polled_again.notified())
            .await
            .unwrap();
        assert_eq!(load_config(data.path(), "alice").unwrap().chat_id, None);
        assert!(PAIRING_CODES.lock().unwrap().contains_key(&key));
        worker.abort();
        server.abort();
        RUNNING.lock().unwrap().remove(&key);
        PAIRING_CODES.lock().unwrap().remove(&key);
        std::env::remove_var("TELEGRAM_API_BASE");
    }
    #[tokio::test]
    async fn ordinary_send_does_not_retry_unconfirmed_delivery_or_follow_redirects() {
        use axum::{
            http::{header, StatusCode},
            routing::post,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        let _env = ENV_LOCK.lock().await;
        let accepted = Arc::new(AtomicUsize::new(0));
        let redirected = Arc::new(AtomicUsize::new(0));
        let delivered = accepted.clone();
        let redirected_count = redirected.clone();
        let app = Router::new()
            .route(
                "/botT/sendMessage",
                post(move || {
                    let delivered = delivered.clone();
                    async move {
                        delivered.fetch_add(1, Ordering::SeqCst);
                        "not a Telegram response"
                    }
                }),
            )
            .route(
                "/botR/sendMessage",
                post(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(header::LOCATION, "/redirected")],
                    )
                }),
            )
            .route(
                "/redirected",
                post(move || {
                    let redirected_count = redirected_count.clone();
                    async move {
                        redirected_count.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "ok": true, "result": {} }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        let first = send_part("T", 42, "synthetic").await;
        let second = send_part("R", 42, "synthetic").await;
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
        assert_eq!(
            (
                first,
                second,
                accepted.load(Ordering::SeqCst),
                redirected.load(Ordering::SeqCst)
            ),
            (false, false, 1, 0)
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn worker_reconciles_enable_while_retiring() {
        use axum::routing::post;
        use tokio::sync::{oneshot, Notify};
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", None, false);
        let key = owner_key(data.path(), "alice").unwrap();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        EXIT_PAUSES
            .lock()
            .unwrap()
            .insert(key.clone(), (entered_tx, release_rx));
        let polled = Arc::new(Notify::new());
        let poll_handler = polled.clone();
        let app = Router::new().route(
            "/bot{token}/getUpdates",
            post(move || {
                let polled = poll_handler.clone();
                async move {
                    polled.notify_one();
                    std::future::pending::<Json<Value>>().await
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        ensure_worker(&state, "alice");
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let _ = super::update(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }),
            Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
            Json(UpdateInput {
                enabled: Some(true),
                new_pairing_code: None,
            }),
        )
        .await
        .unwrap();
        let _ = release_tx.send(());
        tokio::time::timeout(Duration::from_secs(5), polled.notified())
            .await
            .unwrap();
        RUNNING.lock().unwrap().remove(&key);
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn busy_authority_returns_without_waiting_or_mutation() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let _busy = state.hold_auth_admission_for_test().unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            super::update(
                State(state.clone()),
                Extension(AuthenticatedUser {
                    user_id: "alice".into(),
                    username: "alice".into(),
                }),
                Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                Json(UpdateInput {
                    enabled: Some(false),
                    new_pairing_code: None,
                }),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(load_config(data.path(), "alice").unwrap().enabled);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uncertain_disconnect_fences_a_delayed_connect() {
        use axum::routing::post;
        use tokio::sync::Notify;
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (handler_started, handler_release) = (started.clone(), release.clone());
        let app = Router::new().route(
            "/bot{token}/getMe",
            post(move || {
                let (started, release) = (handler_started.clone(), handler_release.clone());
                async move {
                    started.notify_one();
                    release.notified().await;
                    Json(json!({ "ok": true, "result": { "username": "synthetic" } }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        let connect_state = state.clone();
        let connect = tokio::spawn(async move {
            super::connect(
                State(connect_state),
                Extension(AuthenticatedUser {
                    user_id: "alice".into(),
                    username: "alice".into(),
                }),
                Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
                Json(ConnectInput {
                    token: "111:synthetic".into(),
                }),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        FAIL_CONFIRMATIONS
            .lock()
            .unwrap()
            .insert(owner_key(data.path(), "alice").unwrap());
        let error = super::disconnect(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }),
            Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        assert!(load_config(data.path(), "alice").is_none());
        release.notify_one();
        assert_eq!(
            connect.await.unwrap().unwrap_err().status,
            axum::http::StatusCode::CONFLICT
        );
        assert!(load_config(data.path(), "alice").is_none());
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn worker_reconciles_reconnect_after_old_token_cannot_be_decrypted() {
        use axum::routing::post;
        use tokio::sync::{oneshot, Notify};
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:synthetic", None, true);
        let mut invalid = load_config(data.path(), "alice").unwrap();
        invalid.token = "enc:v2:invalid".into();
        save_config(data.path(), &invalid).unwrap();
        let key = owner_key(data.path(), "alice").unwrap();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        EXIT_PAUSES
            .lock()
            .unwrap()
            .insert(key.clone(), (entered_tx, release_rx));
        let polled = Arc::new(Notify::new());
        let poll_handler = polled.clone();
        let app = Router::new()
            .route(
                "/bot{token}/getMe",
                post(|| async {
                    Json(json!({ "ok": true, "result": { "username": "synthetic" } }))
                }),
            )
            .route(
                "/bot{token}/getUpdates",
                post(move || {
                    let polled = poll_handler.clone();
                    async move {
                        polled.notify_one();
                        std::future::pending::<Json<Value>>().await
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        ensure_worker(&state, "alice");
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let _ = super::connect(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }),
            Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
            Json(ConnectInput {
                token: "111:synthetic".into(),
            }),
        )
        .await
        .unwrap();
        let _ = release_tx.send(());
        tokio::time::timeout(Duration::from_secs(5), polled.notified())
            .await
            .unwrap();
        RUNNING.lock().unwrap().remove(&key);
        PAIRING_CODES.lock().unwrap().remove(&key);
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn delayed_old_poll_cannot_overwrite_new_bot_cursor_or_recreate_disconnected_cursor() {
        use axum::{extract::Path as UrlPath, routing::post};
        use tokio::sync::Notify;
        let _env = ENV_LOCK.lock().await;
        let mut outcomes = Vec::new();
        for disconnect in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let state = AppState::new(terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "synthetic-telegram-test-secret".into(),
                ..Default::default()
            })
            .unwrap();
            seed_paired_for_test(data.path(), "alice", "111:synthetic", Some(42), true);
            let initial = load_config(data.path(), "alice").unwrap();
            save_offset(data.path(), &initial, 50).unwrap();
            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let second_polled = Arc::new(Notify::new());
            let second_offset = Arc::new(Mutex::new(None));
            let app = Router::new()
                .route(
                    "/bot{token}/getMe",
                    post(|| async {
                        Json(json!({ "ok": true, "result": { "username": "second" } }))
                    }),
                )
                .route(
                    "/bot{token}/getUpdates",
                    post({
                        let (started, release, second_polled, second_offset) = (
                            started.clone(),
                            release.clone(),
                            second_polled.clone(),
                            second_offset.clone(),
                        );
                        move |UrlPath(token): UrlPath<String>, Json(body): Json<Value>| {
                            let (started, release, second_polled, second_offset) = (
                                started.clone(),
                                release.clone(),
                                second_polled.clone(),
                                second_offset.clone(),
                            );
                            async move {
                                if token == "111:synthetic" {
                                    started.notify_one();
                                    release.notified().await;
                                    Json(json!({ "ok": true, "result": [{ "update_id": 60 }] }))
                                } else {
                                    *second_offset.lock().unwrap() = body["offset"].as_i64();
                                    second_polled.notify_one();
                                    std::future::pending::<Json<Value>>().await
                                }
                            }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
            let key = owner_key(data.path(), "alice").unwrap();
            RUNNING.lock().unwrap().insert(key.clone());
            let worker = tokio::spawn(run(state.clone(), "alice".into()));
            tokio::time::timeout(Duration::from_secs(5), started.notified())
                .await
                .unwrap();
            let user = AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            };
            let auth = Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX)));
            if disconnect {
                let _ = super::disconnect(State(state), Extension(user), auth)
                    .await
                    .unwrap();
            } else {
                let _ = super::connect(
                    State(state),
                    Extension(user),
                    auth,
                    Json(ConnectInput {
                        token: "222:synthetic".into(),
                    }),
                )
                .await
                .unwrap();
            }
            release.notify_one();
            if disconnect {
                tokio::time::timeout(Duration::from_secs(5), worker)
                    .await
                    .unwrap()
                    .unwrap();
                outcomes.push((None, offset_path(data.path(), "alice").exists()));
            } else {
                tokio::time::timeout(Duration::from_secs(5), second_polled.notified())
                    .await
                    .unwrap();
                outcomes.push((*second_offset.lock().unwrap(), false));
                worker.abort();
            }
            RUNNING.lock().unwrap().remove(&key);
            PAIRING_CODES.lock().unwrap().remove(&key);
            std::env::remove_var("TELEGRAM_API_BASE");
            server.abort();
        }
        assert_eq!(outcomes, vec![(Some(0), false), (None, false)]);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn reconnecting_same_bot_preserves_its_offset_across_token_rotation() {
        use axum::routing::post;
        let _env = ENV_LOCK.lock().await;
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "synthetic-telegram-test-secret".into(),
            ..Default::default()
        })
        .unwrap();
        seed_paired_for_test(data.path(), "alice", "111:old-synthetic", Some(42), true);
        let initial = load_config(data.path(), "alice").unwrap();
        save_offset(data.path(), &initial, 71).unwrap();
        let key = owner_key(data.path(), "alice").unwrap();
        RUNNING.lock().unwrap().insert(key.clone());
        let app = Router::new().route(
            "/bot{token}/getMe",
            post(|| async { Json(json!({ "ok": true, "result": { "username": "synthetic" } })) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::env::set_var("TELEGRAM_API_BASE", format!("http://127.0.0.1:{port}"));
        let _ = super::connect(
            State(state),
            Extension(AuthenticatedUser {
                user_id: "alice".into(),
                username: "alice".into(),
            }),
            Some(Extension(LocalAuthority::for_test("alice", 0, i64::MAX))),
            Json(ConnectInput {
                token: "111:new-synthetic".into(),
            }),
        )
        .await
        .unwrap();
        let current = load_config(data.path(), "alice").unwrap();
        let result = load_offset(data.path(), &current);
        RUNNING.lock().unwrap().remove(&key);
        PAIRING_CODES.lock().unwrap().remove(&key);
        std::env::remove_var("TELEGRAM_API_BASE");
        server.abort();
        assert_eq!(result, Ok(71));
    }
}
