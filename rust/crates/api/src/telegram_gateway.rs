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
use std::time::Duration;
use terminal_v4_core::StructuredSessionEvent;

const POLL_SECONDS: u64 = 25;
const MESSAGE_LIMIT: usize = 4000;
const REPLY_WAIT: Duration = Duration::from_secs(30 * 60);

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

static PAIRING_CODES: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
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

async fn call(token: &str, method: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/bot{token}/{method}", api_base()))
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Telegram could not be reached".to_string())?;
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Telegram returned an unexpected reply".to_string())?;
    if value["ok"] != true {
        return Err(value["description"]
            .as_str()
            .unwrap_or("Telegram refused the request")
            .to_owned());
    }
    Ok(value["result"].clone())
}

async fn send(token: &str, chat_id: i64, text: &str) {
    for part in chunks(text) {
        let _ = call(
            token,
            "sendMessage",
            json!({ "chat_id": chat_id, "text": part }),
            Duration::from_secs(20),
        )
        .await;
    }
}

fn pairing_code(user_id: &str) -> String {
    let code = format!("{:06}", rand_code());
    if let Ok(mut codes) = PAIRING_CODES.lock() {
        codes.insert(user_id.to_owned(), code.clone());
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
            "pairingCode": config.chat_id.is_none().then(|| PAIRING_CODES.lock().ok().and_then(|codes| codes.get(user_id).cloned())).flatten(),
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
    let mut offset = 0i64;
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
            json!({ "offset": offset, "timeout": POLL_SECONDS }),
            Duration::from_secs(POLL_SECONDS + 10),
        )
        .await;
        let Ok(updates) = updates else {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        };
        for update in updates.as_array().into_iter().flatten() {
            offset = offset.max(update["update_id"].as_i64().unwrap_or(0) + 1);
            let (Some(chat_id), Some(text)) = (
                update["message"]["chat"]["id"].as_i64(),
                update["message"]["text"].as_str(),
            ) else {
                continue;
            };
            if config.chat_id == Some(chat_id) {
                handle(&state, &mut config, &token, chat_id, text).await;
            } else if config.chat_id.is_none() {
                let expected = PAIRING_CODES
                    .lock()
                    .ok()
                    .and_then(|codes| codes.get(&user_id).cloned());
                if matches!(parse_command(text), Command::Pair(code) if expected.as_deref() == Some(code.as_str()))
                {
                    config.chat_id = Some(chat_id);
                    let _ = save_config(&data_dir, &config);
                    if let Ok(mut codes) = PAIRING_CODES.lock() {
                        codes.remove(&user_id);
                    }
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
        .map_err(ApiError::bad_request)?;
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
}
