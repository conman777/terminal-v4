//! Telegram gateway, like Hermes's messaging gateways: talk to one of your threads from Telegram.
//!
//! The user adds a bot token, then pairs exactly one chat by sending `/pair CODE` to the bot.
//! Messages from any other chat are ignored.
use crate::{auth::AuthenticatedUser, state::AppState, vault::VaultCipher, ApiError};
use axum::{extract::State, routing::get, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
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
}

struct PairingCode {
    code: String,
    issued: Instant,
    attempts: u32,
}

static PAIRING_CODES: LazyLock<Mutex<HashMap<String, PairingCode>>> =
    LazyLock::new(Default::default);
static THREAD_CHOICES: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(Default::default);
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

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
}

impl TelegramError {
    fn new(message: &str) -> Self {
        Self {
            message: message.to_owned(),
            retry_after: None,
        }
    }
}

async fn call(
    token: &str,
    method: &str,
    body: Value,
    timeout: Duration,
) -> Result<Value, TelegramError> {
    let response = reqwest::Client::new()
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
    if value["ok"] != true {
        return Err(TelegramError {
            message: value["description"]
                .as_str()
                .unwrap_or("Telegram refused the request")
                .to_owned(),
            retry_after: value["parameters"]["retry_after"].as_u64(),
        });
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
    for attempt in 0..SEND_ATTEMPTS {
        match call(
            token,
            "sendMessage",
            json!({ "chat_id": chat_id, "text": part }),
            Duration::from_secs(20),
        )
        .await
        {
            Ok(_) => return true,
            Err(error) if attempt + 1 < SEND_ATTEMPTS => {
                let wait = error.retry_after.map_or(Duration::from_secs(1), |seconds| {
                    Duration::from_secs(seconds.min(30))
                });
                tokio::time::sleep(wait).await;
            }
            Err(_) => {}
        }
    }
    false
}

async fn send(token: &str, chat_id: i64, text: &str) {
    for part in chunks(text) {
        if !send_part(token, chat_id, &part).await {
            return;
        }
    }
}

fn offset_path(data_dir: &Path, user_id: &str) -> PathBuf {
    config_path(data_dir, user_id).with_extension("offset")
}

fn load_offset(data_dir: &Path, user_id: &str) -> i64 {
    std::fs::read_to_string(offset_path(data_dir, user_id))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .filter(|offset| *offset >= 0)
        .unwrap_or(0)
}

fn save_offset(data_dir: &Path, user_id: &str, offset: i64) {
    let path = offset_path(data_dir, user_id);
    let Some(parent) = path.parent() else { return };
    let _ = std::fs::create_dir_all(parent);
    if let Ok(file) = tempfile::NamedTempFile::new_in(parent) {
        if std::fs::write(file.path(), offset.to_string()).is_ok() {
            let _ = file.persist(&path);
        }
    }
}

#[derive(Debug, PartialEq)]
enum Inbound {
    Ignore,
    Text { chat_id: i64, text: String },
    Attachment { chat_id: i64 },
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
    let has_attachment = ["photo", "document", "voice", "audio", "video", "video_note"]
        .iter()
        .any(|key| !message[*key].is_null());
    if has_attachment {
        Inbound::Attachment { chat_id }
    } else {
        Inbound::Ignore
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

fn check_pairing(
    codes: &mut HashMap<String, PairingCode>,
    user_id: &str,
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

fn pairing_code(user_id: &str) -> String {
    let code = format!("{:06}", rand_code());
    if let Ok(mut codes) = PAIRING_CODES.lock() {
        codes.insert(
            user_id.to_owned(),
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
            "pairingCode": config.chat_id.is_none().then(|| PAIRING_CODES.lock().ok().and_then(|codes| codes.get(user_id).filter(|entry| entry.issued.elapsed() <= PAIRING_TTL).map(|entry| entry.code.clone()))).flatten(),
        }),
    }
}

async fn relay_reply(
    state: AppState,
    user_id: String,
    session_id: String,
    token: String,
    chat_id: i64,
    text: String,
) {
    let manager = state.structured_session_manager();
    let Ok((_, mut events)) = manager.subscribe(&user_id, &session_id).await else {
        send(
            &token,
            chat_id,
            "That thread is no longer available. Send /threads to choose another.",
        )
        .await;
        return;
    };
    if let Err(error) = manager.submit(&user_id, &session_id, &text, None).await {
        send(
            &token,
            chat_id,
            &format!("The thread did not accept the message: {}", error.message),
        )
        .await;
        return;
    }
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
                    send(&token, chat_id, &approval_notice(&tool_name)).await;
                }
                StructuredSessionEvent::InputRequired { .. } => {
                    send(
                        &token,
                        chat_id,
                        "The thread is asking a question. Answer it in the Terminal v4 app.",
                    )
                    .await;
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
    send(&token, chat_id, &text).await;
}

async fn handle(state: &AppState, config: &mut Config, token: &str, chat_id: i64, text: &str) {
    let data_dir = state.config().data_dir.clone();
    match parse_command(text) {
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
            if let Ok(mut choices) = THREAD_CHOICES.lock() {
                choices.insert(config.owner.clone(), ids);
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
        Command::Use(number) => {
            let chosen = THREAD_CHOICES.lock().ok().and_then(|choices| {
                choices
                    .get(&config.owner)?
                    .get(number.wrapping_sub(1))
                    .cloned()
            });
            match chosen {
                Some(id) => {
                    config.session_id = Some(id);
                    let _ = save_config(&data_dir, config);
                    send(
                        token,
                        chat_id,
                        "Thread selected. Messages you send now go to it.",
                    )
                    .await;
                }
                None => {
                    send(
                        token,
                        chat_id,
                        "Send /threads first, then /use with a number from that list.",
                    )
                    .await
                }
            }
        }
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
                    config.owner.clone(),
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
    let mut offset = load_offset(&data_dir, &user_id);
    let mut failures = 0u32;
    loop {
        let Some(mut config) = load_config(&data_dir, &user_id).filter(|config| config.enabled)
        else {
            break;
        };
        let Ok(token) =
            VaultCipher::load(&data_dir).and_then(|cipher| cipher.decrypt(&config.token))
        else {
            break;
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
            offset = update_id + 1;
            save_offset(&data_dir, &user_id, offset);
            let inbound = classify_update(update);
            let chat_id = match &inbound {
                Inbound::Text { chat_id, .. } | Inbound::Attachment { chat_id } => *chat_id,
                Inbound::Ignore => continue,
            };
            if config.chat_id == Some(chat_id) {
                match inbound {
                    Inbound::Text { text, .. } => {
                        handle(&state, &mut config, &token, chat_id, &text).await
                    }
                    _ => {
                        send(
                            &token,
                            chat_id,
                            "Attachments are not forwarded to threads yet. Send text instead.",
                        )
                        .await
                    }
                }
            } else if config.chat_id.is_none() {
                let Inbound::Text { text, .. } = inbound else {
                    continue;
                };
                let paired = match parse_command(&text) {
                    Command::Pair(code) => PAIRING_CODES
                        .lock()
                        .map(|mut codes| check_pairing(&mut codes, &user_id, &code, Instant::now()))
                        .unwrap_or(false),
                    _ => false,
                };
                if paired {
                    config.chat_id = Some(chat_id);
                    let _ = save_config(&data_dir, &config);
                    send(
                        &token,
                        chat_id,
                        "Paired with Terminal v4. Send /threads to choose a thread.",
                    )
                    .await;
                }
            }
        }
    }
    if let Ok(mut running) = RUNNING.lock() {
        running.remove(&user_id);
    }
}

fn ensure_worker(state: &AppState, user_id: &str) {
    let started = RUNNING
        .lock()
        .map(|mut running| running.insert(user_id.to_owned()))
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

async fn connect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
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
    let me = call(token, "getMe", json!({}), Duration::from_secs(15))
        .await
        .map_err(|error| ApiError::bad_request(error.message))?;
    let cipher = VaultCipher::load(&state.config().data_dir).map_err(ApiError::internal)?;
    let data_dir = state.config().data_dir.clone();
    save_config(
        &data_dir,
        &Config {
            owner: user.user_id.clone(),
            token: cipher.encrypt(token).map_err(ApiError::internal)?,
            bot_name: me["username"].as_str().unwrap_or("your bot").to_owned(),
            chat_id: None,
            session_id: None,
            enabled: true,
        },
    )?;
    pairing_code(&user.user_id);
    ensure_worker(&state, &user.user_id);
    Ok(Json(status(&data_dir, &user.user_id)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateInput {
    enabled: Option<bool>,
    /// Issue a new pairing code (codes are kept in memory, so a restart clears them).
    new_pairing_code: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<UpdateInput>,
) -> Result<Json<Value>, ApiError> {
    let data_dir = state.config().data_dir.clone();
    let mut config = load_config(&data_dir, &user.user_id)
        .ok_or_else(|| ApiError::not_found("Telegram is not connected"))?;
    if let Some(enabled) = input.enabled {
        config.enabled = enabled;
    }
    if input.new_pairing_code == Some(true) {
        config.chat_id = None;
        pairing_code(&user.user_id);
    }
    save_config(&data_dir, &config)?;
    if config.enabled {
        ensure_worker(&state, &user.user_id);
    }
    Ok(Json(status(&data_dir, &user.user_id)))
}

async fn disconnect(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Json<Value> {
    let data_dir = state.config().data_dir.clone();
    let _ = std::fs::remove_file(config_path(&data_dir, &user.user_id));
    let _ = std::fs::remove_file(offset_path(&data_dir, &user.user_id));
    if let Ok(mut codes) = PAIRING_CODES.lock() {
        codes.remove(&user.user_id);
    }
    Json(status(&data_dir, &user.user_id))
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

    fn code_for(user: &str, code: &str, issued: Instant) -> HashMap<String, PairingCode> {
        HashMap::from([(
            user.to_owned(),
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
                check_pairing(&mut codes, "u", "123456", now),
                check_pairing(&mut codes, "u", "123456", now)
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
            (check_pairing(&mut codes, "u", "123456", late), codes.len()),
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
                "u",
                &format!("00000{guess}"),
                now
            ));
        }
        assert_eq!(
            (check_pairing(&mut codes, "u", "123456", now), codes.len()),
            (false, 0)
        );
    }

    #[test]
    fn pairing_rejects_unknown_user_and_length_mismatch() {
        let now = Instant::now();
        let mut codes = code_for("u", "123456", now);
        assert_eq!(
            (
                check_pairing(&mut codes, "other", "123456", now),
                check_pairing(&mut codes, "u", "12345", now),
                check_pairing(&mut codes, "u", "", now),
            ),
            (false, false, false)
        );
    }

    #[test]
    fn offset_survives_restart_and_ignores_garbage() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(load_offset(data.path(), "u"), 0);
        save_offset(data.path(), "u", 42);
        let restored = load_offset(data.path(), "u");
        std::fs::write(offset_path(data.path(), "u"), "junk").unwrap();
        assert_eq!(
            (
                restored,
                load_offset(data.path(), "u"),
                load_offset(data.path(), "v")
            ),
            (42, 0, 0)
        );
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
}
