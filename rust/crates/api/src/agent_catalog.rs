use crate::{
    agent_runtime::{native_command, native_launch_command},
    auth::AuthenticatedUser,
    state::AppState,
    vault, ApiError,
};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/catalog", axum::routing::get(catalog))
        .route("/api/agent/auth", axum::routing::get(authentication))
        .route(
            "/api/agent/auth/{provider}/api-key",
            axum::routing::put(save_key).delete(delete_key),
        )
}
fn definitions() -> Vec<Value> {
    serde_json::from_str(include_str!("agent_provider_definitions.json"))
        .expect("checked static provider metadata")
}
fn accepts_key(provider: &str) -> bool {
    definitions().iter().any(|entry| {
        entry["id"] == provider
            && entry["auth"] != "virtual"
            && (entry["auth"] == "api-key"
                || entry["authMethods"]
                    .as_array()
                    .is_some_and(|methods| methods.contains(&json!("api-key"))))
    })
}
fn provider_name(provider: &str) -> String {
    format!("terminal-v4:provider:{provider}")
}
fn credentials(
    state: &AppState,
    user: &AuthenticatedUser,
) -> Result<HashMap<String, String>, ApiError> {
    let encryption_key = crate::vault_encryption_key();
    Ok(state
        .list_vault_keys(user)
        .map_err(ApiError::internal)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .key_name
                .strip_prefix("terminal-v4:provider:")
                .and_then(|id| {
                    vault::decrypt_secret(&entry.key_value, &encryption_key)
                        .ok()
                        .map(|secret| (id.to_owned(), secret))
                })
        })
        .collect())
}
fn mask(secret: &str) -> String {
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("****{suffix}")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApiKeyInput {
    api_key: String,
}
async fn save_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(provider): Path<String>,
    Json(input): Json<ApiKeyInput>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    if !accepts_key(&provider) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Provider does not accept API keys".into(),
        });
    }
    let secret = input.api_key.trim();
    if !(8..=10000).contains(&secret.chars().count()) || secret.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "API key must be 8-10000 characters without control characters",
        ));
    }
    let encrypted = vault::encrypt_secret(secret, &crate::vault_encryption_key())
        .map_err(|_| ApiError::internal("Could not encrypt credential"))?;
    let name = provider_name(&provider);
    let mut database = state.lock_db().map_err(ApiError::internal)?;
    let transaction = database
        .transaction()
        .map_err(|_| ApiError::internal("Could not save credential"))?;
    transaction
        .execute(
            "DELETE FROM api_key_vault WHERE user_id=?1 AND key_name=?2",
            rusqlite::params![user.user_id, name],
        )
        .map_err(|_| ApiError::internal("Could not save credential"))?;
    transaction.execute("INSERT INTO api_key_vault (id,user_id,key_name,key_value,created_at) VALUES (?1,?2,?3,?4,?5)",rusqlite::params![uuid::Uuid::new_v4().to_string(),user.user_id,name,encrypted,crate::iso_timestamp()]).map_err(|_|ApiError::internal("Could not save credential"))?;
    transaction
        .commit()
        .map_err(|_| ApiError::internal("Could not save credential"))?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"provider":provider,"configured":true,"masked":mask(secret)})),
    ))
}
async fn delete_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(provider): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !accepts_key(&provider) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Provider does not accept API keys".into(),
        });
    }
    state
        .lock_db()
        .map_err(ApiError::internal)?
        .execute(
            "DELETE FROM api_key_vault WHERE user_id=?1 AND key_name=?2",
            rusqlite::params![user.user_id, provider_name(&provider)],
        )
        .map_err(|_| ApiError::internal("Could not remove credential"))?;
    Ok(StatusCode::NO_CONTENT)
}
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}
fn read_bounded(path: PathBuf, limit: u64) -> Option<String> {
    if std::fs::metadata(&path).ok()?.len() > limit {
        return None;
    }
    std::fs::read_to_string(path).ok()
}
fn models(provider: &str) -> Value {
    if provider == "codex" {
        if let Some(home) = home() {
            if let Some(cache) = read_bounded(home.join(".codex/models_cache.json"), 2_000_000)
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            {
                if let Some(models) = cache["models"].as_array() {
                    let selected =
                        read_bounded(home.join(".codex/config.toml"), 100_000).and_then(|config| {
                            config.lines().find_map(|line| {
                                line.trim()
                                    .strip_prefix("model =")
                                    .map(|value| value.trim().trim_matches(['\"', '\'']).to_owned())
                            })
                        });
                    let visible:Vec<_>=models.iter().filter(|model|model["visibility"]!="hide").filter_map(|model|model["slug"].as_str().filter(|slug|slug.len()<=200).map(|slug|json!({"id":slug,"label":model["display_name"].as_str().unwrap_or(slug),"default":selected.as_deref()==Some(slug)}))).take(100).collect();
                    if !visible.is_empty() {
                        return Value::Array(visible);
                    }
                }
            }
        }
        return json!([]);
    }
    if provider == "claude" {
        return json!([{"id":"sonnet","label":"Sonnet","default":true},{"id":"opus","label":"Opus"},{"id":"haiku","label":"Haiku"}]);
    }
    if provider == "gemini" {
        return json!([{"id":"auto","label":"Auto","default":true}]);
    }
    json!([])
}
async fn native_state(provider: &str, label: &str) -> Value {
    let command = native_command(provider);
    let launch = command.as_ref().and_then(native_launch_command);
    let available = command.is_some() && launch.is_some();
    let authenticated: Option<bool> = None;
    json!({"id":provider,"label":label,"command":provider,"launchCommand":launch,"hostShell":if cfg!(windows){"cmd"}else{"posix"},"available":available,"authenticated":authenticated,"status":if available{"ready"}else{"not-installed"},"models":models(provider),"reasoningLevels":if ["codex","claude"].contains(&provider){json!(["low","medium","high","xhigh","max"])}else{json!([])},"capabilities":{"tools":true,"nativeRuntime":true,"structured":provider=="claude","durableTasks":(["codex","claude","hermes"].contains(&provider)),"learning":provider=="hermes","authenticationStatus":"unknown"}})
}
async fn catalog(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let credentials = credentials(&state, &user)?;
    let mut agents = Vec::new();
    for (provider, label) in [
        ("codex", "Codex"),
        ("claude", "Claude Code"),
        ("gemini", "Gemini CLI"),
        ("hermes", "Hermes Agent"),
    ] {
        agents.push(native_state(provider, label).await);
    }
    for definition in definitions() {
        let id = definition["id"].as_str().unwrap_or_default();
        let configured = credentials.contains_key(id);
        let compatible = crate::hermes_provider_bridge::provider_mapping(id).is_some();
        let runtime_available = compatible && native_command("hermes").is_some();
        let launch = std::env::current_exe().ok().and_then(|executable| {
            let mut command = tokio::process::Command::new(executable);
            command.args([
                "agent",
                "--owner-hex",
                &hex::encode(user.user_id.as_bytes()),
            ]);
            native_launch_command(&command)
        });
        let available = runtime_available && configured && launch.is_some();
        agents.push(json!({"id":id,"label":definition["label"],"command":"terminal-v4-api","launchCommand":if compatible{launch}else{None},"hostShell":if cfg!(windows){"cmd"}else{"posix"},"runtime":if compatible{"hermes"}else{"unavailable"},"available":available,"runtimeAvailable":runtime_available,"authenticated":null,"configured":configured,"status":if !compatible{"unsupported"}else if !runtime_available{"not-installed"}else if !configured{"not-configured"}else{"ready"},"models":definition["models"],"reasoningLevels":definition["reasoningLevels"],"capabilities":{"tools":compatible,"nativeRuntime":compatible,"structured":false,"durableTasks":compatible,"learning":compatible,"authenticationStatus":"unknown"},"help":if compatible{"Runs through the installed Hermes tool engine using this account's encrypted API key. Provider credentials are checked when a session starts."}else{"This provider needs an adapter or additional account configuration; it cannot launch from this host yet."}}));
    }
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"defaultAgent":"codex","agents":agents})),
    ))
}
async fn authentication(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let credentials = credentials(&state, &user)?;
    let mut providers = vec![
        json!({"id":"codex","label":"Codex","methods":["oauth"],"command":"codex login","help":"Sign in using the native Codex CLI.","configured":null}),
        json!({"id":"claude","label":"Claude Code","methods":["oauth"],"command":"claude auth login","help":"Sign in using the native Claude CLI.","configured":null}),
        json!({"id":"gemini","label":"Gemini CLI","methods":["oauth"],"command":"gemini","configured":null}),
        json!({"id":"hermes","label":"Hermes Agent","methods":["cli"],"command":"hermes setup","help":"Configure a model provider using Hermes setup.","configured":null}),
    ];
    for definition in definitions() {
        let id = definition["id"].as_str().unwrap_or_default();
        let credential = credentials.get(id);
        let methods = definition
            .get("authMethods")
            .cloned()
            .unwrap_or_else(|| json!([definition["auth"]]));
        providers.push(json!({"id":id,"label":definition["label"],"methods":methods,"command":definition.get("oauthCommand").or_else(||definition.get("command")),"help":definition.get("oauthHelp").or_else(||definition.get("commandHelp")),"status":if credential.is_some(){"ready"}else{"not-configured"},"configured":credential.is_some(),"masked":credential.map(|secret|mask(secret)),"models":definition["models"].as_array().map(Vec::len).unwrap_or(0)}));
    }
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"providers":providers})),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{issue_access_token, require_auth, AuthenticatedUser};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
    };
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState::new(AppConfig {
            data_dir: tempfile::tempdir().unwrap().keep(),
            jwt_secret: "catalog-test".into(),
            ..Default::default()
        })
        .unwrap()
    }
    fn router(state: AppState) -> Router {
        routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state)
    }
    fn request(method: &str, path: &str, user: Option<&str>, body: &str) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(user) = user {
            builder = builder.header(
                "authorization",
                format!("Bearer {}", issue_access_token("catalog-test", user, user)),
            );
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }
    async fn json(response: axum::response::Response) -> serde_json::Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn catalog_and_auth_require_authentication() {
        let app = router(state());
        for path in [
            "/api/agent/catalog",
            "/api/agent/auth",
            "/api/agent/auth/deepseek/api-key",
        ] {
            let method = if path.ends_with("api-key") {
                "PUT"
            } else {
                "GET"
            };
            assert_eq!(
                app.clone()
                    .oneshot(request(method, path, None, "{}"))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    #[tokio::test]
    async fn api_keys_are_encrypted_owner_scoped_and_masked() {
        let state = state();
        let app = router(state.clone());
        let secret = "provider-secret-value";
        let response = app
            .clone()
            .oneshot(request(
                "PUT",
                "/api/agent/auth/deepseek/api-key",
                Some("owner"),
                &format!(r#"{{"apiKey":"{secret}"}}"#),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json(response).await,
            serde_json::json!({"provider":"deepseek","configured":true,"masked":"****alue"})
        );
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let owner_response = app
            .clone()
            .oneshot(request("GET", "/api/agent/auth", Some("owner"), ""))
            .await
            .unwrap();
        let owner_json = json(owner_response).await;
        assert!(!owner_json.to_string().contains(secret));
        let provider = owner_json["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "deepseek")
            .unwrap();
        assert_eq!(
            (provider["configured"].clone(), provider["masked"].clone()),
            (serde_json::json!(true), serde_json::json!("****alue"))
        );
        let other_response = app
            .clone()
            .oneshot(request("GET", "/api/agent/auth", Some("other"), ""))
            .await
            .unwrap();
        let other_json = json(other_response).await;
        let provider = other_json["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "deepseek")
            .unwrap();
        assert_eq!(
            (provider["configured"].clone(), provider["masked"].clone()),
            (serde_json::json!(false), serde_json::Value::Null)
        );
        let stored = state.list_vault_keys(&user).unwrap();
        assert_ne!(stored[0].key_value, secret);
        assert_eq!(
            crate::vault::decrypt_secret(&stored[0].key_value, &crate::vault_encryption_key())
                .unwrap(),
            secret
        );
        app.clone()
            .oneshot(request(
                "DELETE",
                "/api/agent/auth/deepseek/api-key",
                Some("other"),
                "",
            ))
            .await
            .unwrap();
        assert_eq!(state.list_vault_keys(&user).unwrap().len(), 1);
        app.clone()
            .oneshot(request(
                "DELETE",
                "/api/agent/auth/deepseek/api-key",
                Some("owner"),
                "",
            ))
            .await
            .unwrap();
        assert!(state.list_vault_keys(&user).unwrap().is_empty());
    }
    #[tokio::test]
    async fn rejects_unknown_providers_short_keys_and_oauth_only_keys() {
        let app = router(state());
        for (provider, key, status) in [
            ("unknown", "valid-secret", StatusCode::NOT_FOUND),
            ("copilot", "valid-secret", StatusCode::NOT_FOUND),
            ("deepseek", "short", StatusCode::BAD_REQUEST),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(
                        "PUT",
                        &format!("/api/agent/auth/{provider}/api-key"),
                        Some("owner"),
                        &format!(r#"{{"apiKey":"{key}"}}"#)
                    ))
                    .await
                    .unwrap()
                    .status(),
                status
            );
        }
    }
    #[tokio::test]
    async fn catalog_retains_hermes_and_api_entries_with_honest_capabilities() {
        let response = router(state())
            .oneshot(request("GET", "/api/agent/catalog", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let catalog = json(response).await;
        let agents = catalog["agents"].as_array().unwrap();
        let hermes = agents.iter().find(|entry| entry["id"] == "hermes").unwrap();
        assert_eq!(hermes["capabilities"]["tools"], true);
        let api = agents
            .iter()
            .find(|entry| entry["id"] == "deepseek")
            .unwrap();
        assert_eq!(api["capabilities"]["tools"], true);
        assert_eq!(api["runtime"], "hermes");
        assert_eq!(api["configured"], false);
        assert_eq!(api["available"], false);
    }
}
