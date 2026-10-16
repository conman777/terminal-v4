use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub(crate) fn provider_mapping(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "anthropic-api" => Some(("anthropic", "ANTHROPIC_API_KEY")),
        "openai-api" => Some(("openai-api", "OPENAI_API_KEY")),
        "deepseek" => Some(("deepseek", "DEEPSEEK_API_KEY")),
        "openrouter" => Some(("openrouter", "OPENROUTER_API_KEY")),
        "xai" => Some(("xai", "XAI_API_KEY")),
        "actual" => Some(("actual", "ACTUAL_API_KEY")),
        "tencent-tokenhub" => Some(("tencent-tokenhub", "TOKENHUB_API_KEY")),
        "zai" => Some(("zai", "GLM_API_KEY")),
        "minimax" => Some(("minimax", "MINIMAX_API_KEY")),
        "minimax-cn" => Some(("minimax-cn", "MINIMAX_CN_API_KEY")),
        "kimi-coding" => Some(("kimi-coding", "KIMI_API_KEY")),
        "kimi-coding-cn" => Some(("kimi-coding-cn", "KIMI_CN_API_KEY")),
        "alibaba" => Some(("alibaba", "DASHSCOPE_API_KEY")),
        "alibaba-coding-plan" => Some(("alibaba-coding-plan", "ALIBABA_CODING_PLAN_API_KEY")),
        "xiaomi" => Some(("xiaomi", "XIAOMI_API_KEY")),
        "huggingface" => Some(("huggingface", "HF_TOKEN")),
        "nvidia" => Some(("nvidia", "NVIDIA_API_KEY")),
        "gmi" => Some(("gmi", "GMI_API_KEY")),
        "arcee" => Some(("arcee", "ARCEEAI_API_KEY")),
        "stepfun" => Some(("stepfun", "STEPFUN_API_KEY")),
        "kilocode" => Some(("kilocode", "KILOCODE_API_KEY")),
        "ai-gateway" => Some(("ai-gateway", "AI_GATEWAY_API_KEY")),
        "opencode-zen" => Some(("opencode-zen", "OPENCODE_ZEN_API_KEY")),
        "opencode-go" => Some(("opencode-go", "OPENCODE_GO_API_KEY")),
        "ollama-cloud" => Some(("ollama-cloud", "OLLAMA_API_KEY")),
        _ => None,
    }
}

fn owned_key(data_dir: &Path, owner: &str, provider: &str) -> Result<String, String> {
    let connection = rusqlite::Connection::open_with_flags(
        data_dir.join("terminal.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Credential store is unavailable".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Credential store is unavailable".to_string())?;
    let encrypted: String = connection.query_row("SELECT key_value FROM api_key_vault WHERE user_id=?1 AND key_name=?2 ORDER BY created_at DESC LIMIT 1", rusqlite::params![owner, format!("terminal-v4:provider:{provider}")], |row| row.get(0)).map_err(|_| "Configure an API key for this provider and account".to_string())?;
    crate::vault::decrypt_secret(&encrypted, &crate::vault_encryption_key())
        .map_err(|_| "Could not decrypt provider credential".to_string())
}

fn scoped_home(data_dir: &Path, owner: &str, provider: &str) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(owner.as_bytes());
    digest.update([0]);
    digest.update(provider.as_bytes());
    data_dir
        .join("hermes-profiles")
        .join("profiles")
        .join(hex::encode(digest.finalize()))
}

fn configure_command(
    mut command: Command,
    data_dir: &Path,
    owner: &str,
    provider_key: (&str, &str),
    model: Option<&str>,
    reasoning: Option<&str>,
    prompt: Option<&str>,
) -> Result<Command, String> {
    let (provider, secret) = provider_key;
    let (runtime_provider, key_env) = provider_mapping(provider)
        .ok_or_else(|| "This provider has no supported Hermes adapter".to_string())?;
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        return Err("Invalid account".into());
    }
    if model.is_some_and(|value| {
        value.trim().is_empty() || value.len() > 200 || value.chars().any(char::is_control)
    }) {
        return Err("Invalid model".into());
    }
    if reasoning.is_some_and(|value| {
        ![
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
        .contains(&value)
    }) {
        return Err("Invalid reasoning level".into());
    }
    if prompt.is_some_and(|value| {
        value.trim().is_empty() || value.contains(char::from(0)) || value.chars().count() > 50_000
    }) {
        return Err("Invalid task prompt".into());
    }
    let default_model = if model.is_none() {
        serde_json::from_str::<Vec<serde_json::Value>>(include_str!(
            "agent_provider_definitions.json"
        ))
        .ok()
        .and_then(|entries| entries.into_iter().find(|entry| entry["id"] == provider))
        .and_then(|entry| {
            entry["models"]
                .as_array()
                .and_then(|models| {
                    models
                        .iter()
                        .find(|model| model["default"] == true)
                        .or_else(|| models.first())
                })
                .and_then(|model| model["id"].as_str())
                .map(str::to_owned)
        })
    } else {
        None
    };
    let model = model.or(default_model.as_deref());
    let home = scoped_home(data_dir, owner, provider);
    std::fs::create_dir_all(&home)
        .map_err(|_| "Could not prepare isolated Hermes profile".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect Hermes profile".to_string())?;
    }
    if home
        .join(".env")
        .metadata()
        .is_ok_and(|metadata| metadata.len() > 0)
    {
        return Err("This isolated Hermes profile contains local credentials; remove its .env before using the app vault".into());
    }
    match std::fs::read(home.join("auth.json")) {
        Ok(contents) => {
            if contents.len() > 1_000_000 {
                return Err("Isolated Hermes credentials are too large".into());
            }
            let value = serde_json::from_slice::<serde_json::Value>(&contents)
                .map_err(|_| "Isolated Hermes credentials are invalid".to_string())?;
            let mut pending = vec![&value];
            while let Some(value) = pending.pop() {
                match value {
                    serde_json::Value::Object(values) => {
                        for (name, value) in values {
                            if [
                                "access_token",
                                "refresh_token",
                                "api_key",
                                "agent_key",
                                "token",
                                "oauth_token",
                            ]
                            .contains(&name.as_str())
                                && !value.is_null()
                                && value.as_str() != Some("")
                            {
                                return Err("Isolated Hermes profile contains inline credentials; use the app vault".into());
                            }
                            pending.push(value);
                        }
                    }
                    serde_json::Value::Array(values) => pending.extend(values),
                    _ => {}
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not inspect isolated Hermes credentials".into()),
    }
    command.env_clear();
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("HERMES_HOME", &home)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env(key_env, secret)
        .arg("chat")
        .args(["--provider", runtime_provider, "--ignore-user-config"]);
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    if let Some(reasoning) = reasoning {
        command.args(["--reasoning", reasoning]);
    }
    if let Some(prompt) = prompt {
        command.args(["--query", prompt, "--quiet"]);
    }
    Ok(command)
}

pub(crate) fn owner_task_command(
    data_dir: &Path,
    owner: &str,
    provider: &str,
    prompt: &str,
    model: Option<&str>,
    cwd: &Path,
) -> Result<Command, String> {
    if provider_mapping(provider).is_none() {
        return crate::agent_runtime::task_command(provider, prompt, model, cwd);
    }
    let secret = owned_key(data_dir, owner, provider)?;
    let command = crate::agent_runtime::native_command("hermes")
        .ok_or_else(|| "Hermes is not installed on this host".to_string())?;
    let mut command = configure_command(
        command,
        data_dir,
        owner,
        (provider, &secret),
        model,
        None,
        Some(prompt),
    )?;
    command.current_dir(cwd).kill_on_drop(true);
    Ok(command)
}

pub async fn run_agent_bridge(data_dir: &Path, arguments: &[String]) -> Result<i32, String> {
    let mut provider = None;
    let mut owner = None;
    let mut model = None;
    let mut reasoning = None;
    if !arguments.len().is_multiple_of(2) {
        return Err("Expected provider and account options".into());
    }
    for pair in arguments.chunks_exact(2) {
        let target = match pair[0].as_str() {
            "--provider" => &mut provider,
            "--owner-hex" => &mut owner,
            "--model" => &mut model,
            "--reasoning" => &mut reasoning,
            _ => return Err("Unsupported agent option".into()),
        };
        if target.replace(pair[1].as_str()).is_some() {
            return Err("Duplicate agent option".into());
        }
    }
    let provider = provider.ok_or_else(|| "Provider is required".to_string())?;
    if provider_mapping(provider).is_none() {
        return Err("This provider has no supported Hermes adapter".into());
    }
    let owner = String::from_utf8(
        hex::decode(owner.ok_or_else(|| "Account is required".to_string())?)
            .map_err(|_| "Invalid account".to_string())?,
    )
    .map_err(|_| "Invalid account".to_string())?;
    let secret = owned_key(data_dir, &owner, provider)?;
    let command = crate::agent_runtime::native_command("hermes")
        .ok_or_else(|| "Hermes is not installed on this host".to_string())?;
    let mut command = configure_command(
        command,
        data_dir,
        &owner,
        (provider, &secret),
        model,
        reasoning,
        None,
    )?;
    command
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    command
        .status()
        .await
        .map(|status| status.code().unwrap_or(1))
        .map_err(|_| "Could not start Hermes".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_keeps_credentials_out_of_arguments_and_isolates_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let command = configure_command(
            Command::new("hermes"),
            directory.path(),
            "owner",
            ("deepseek", "private-secret"),
            Some("deepseek-chat"),
            Some("high"),
            Some("literal $(command) & text"),
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "chat",
                "--provider",
                "deepseek",
                "--ignore-user-config",
                "--model",
                "deepseek-chat",
                "--reasoning",
                "high",
                "--query",
                "literal $(command) & text",
                "--quiet"
            ]
        );
        assert!(!args.join(" ").contains("private-secret"));
        let environment = command
            .as_std()
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            environment.get(std::ffi::OsStr::new("DEEPSEEK_API_KEY")),
            Some(&Some(std::ffi::OsStr::new("private-secret")))
        );
        assert!(!environment.contains_key(std::ffi::OsStr::new("OPENAI_API_KEY")));
        assert_ne!(
            scoped_home(directory.path(), "owner", "deepseek"),
            scoped_home(directory.path(), "other", "deepseek")
        );
        assert_eq!(
            std::fs::read_dir(scoped_home(directory.path(), "owner", "deepseek"))
                .unwrap()
                .count(),
            0
        );
    }
    #[tokio::test]
    async fn compatible_child_receives_only_its_vault_key_and_literal_prompt() {
        let directory = tempfile::tempdir().unwrap();
        let mut fixture = Command::new("python");
        fixture.args(["-c", "import json,os,sys; print(json.dumps({'ownedKey':os.environ.get('DEEPSEEK_API_KEY')=='vault-secret','otherKeyAbsent':'OPENAI_API_KEY' not in os.environ,'args':sys.argv[1:]}))"]);
        fixture.env("OPENAI_API_KEY", "operator-secret");
        let mut command = configure_command(
            fixture,
            directory.path(),
            "owner",
            ("deepseek", "vault-secret"),
            Some("deepseek-chat"),
            None,
            Some("literal $(cmd) & text"),
        )
        .unwrap();
        let output = command.output().await.unwrap();
        assert!(output.status.success());
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            response,
            serde_json::json!({"ownedKey":true,"otherKeyAbsent":true,"args":["chat","--provider","deepseek","--ignore-user-config","--model","deepseek-chat","--query","literal $(cmd) & text","--quiet"]})
        );
    }

    #[test]
    fn refuses_local_credential_overrides_and_scopes_windows_auth_fallbacks() {
        let directory = tempfile::tempdir().unwrap();
        let home = scoped_home(directory.path(), "owner", "deepseek");
        let command = configure_command(
            Command::new("hermes"),
            directory.path(),
            "owner",
            ("deepseek", "vault-secret"),
            Some("deepseek-chat"),
            None,
            None,
        )
        .unwrap();
        let environment = command
            .as_std()
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            environment.get(std::ffi::OsStr::new("LOCALAPPDATA")),
            Some(&Some(home.join("AppData/Local").as_os_str()))
        );
        std::fs::write(
            home.join("auth.json"),
            r#"{"providers":{"deepseek":{"access_token":"local-key"}}}"#,
        )
        .unwrap();
        assert!(configure_command(
            Command::new("hermes"),
            directory.path(),
            "owner",
            ("deepseek", "vault-secret"),
            Some("deepseek-chat"),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn credential_lookup_is_read_only_and_requires_exact_owner_and_provider() {
        let directory = tempfile::tempdir().unwrap();
        let connection = rusqlite::Connection::open(directory.path().join("terminal.db")).unwrap();
        connection.execute_batch("CREATE TABLE api_key_vault(user_id TEXT,key_name TEXT,key_value TEXT,created_at TEXT);").unwrap();
        let encrypted =
            crate::vault::encrypt_secret("private-secret", &crate::vault_encryption_key()).unwrap();
        connection
            .execute(
                "INSERT INTO api_key_vault VALUES (?1,?2,?3,'now')",
                rusqlite::params!["owner", "terminal-v4:provider:deepseek", encrypted],
            )
            .unwrap();
        assert_eq!(
            owned_key(directory.path(), "owner", "deepseek").unwrap(),
            "private-secret"
        );
        assert!(owned_key(directory.path(), "other", "deepseek").is_err());
        assert!(owned_key(directory.path(), "owner", "openai-api").is_err());
        assert!(provider_mapping("xai-oauth").is_none());
        assert!(provider_mapping("bedrock").is_none());
        assert!(configure_command(
            Command::new("hermes"),
            directory.path(),
            "owner",
            ("deepseek", "secret"),
            Some("bad\nmodel"),
            None,
            None
        )
        .is_err());
    }
}
