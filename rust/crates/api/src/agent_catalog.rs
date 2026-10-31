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
#[cfg(test)]
fn credentials(
    state: &AppState,
    user: &AuthenticatedUser,
) -> Result<HashMap<String, String>, ApiError> {
    let cipher = vault::VaultCipher::load(&state.config().data_dir).map_err(ApiError::internal)?;
    Ok(state
        .list_vault_keys(user)
        .map_err(ApiError::internal)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .key_name
                .strip_prefix("terminal-v4:provider:")
                .and_then(|id| {
                    cipher
                        .decrypt(&entry.key_value)
                        .ok()
                        .map(|secret| (id.to_owned(), secret))
                })
        })
        .collect())
}

fn credentials_in_connection(
    state: &AppState,
    user: &AuthenticatedUser,
    connection: &rusqlite::Connection,
) -> Result<HashMap<String, String>, String> {
    let cipher = vault::VaultCipher::load(&state.config().data_dir)?;
    Ok(AppState::list_vault_keys_from_connection(connection, user)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .key_name
                .strip_prefix("terminal-v4:provider:")
                .and_then(|id| {
                    cipher
                        .decrypt(&entry.key_value)
                        .ok()
                        .map(|secret| (id.to_owned(), secret))
                })
        })
        .collect())
}

async fn credential_snapshot(
    state: AppState,
    user: AuthenticatedUser,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
) -> Result<HashMap<String, String>, ApiError> {
    tokio::task::spawn_blocking(move || match (local, paired) {
        (Some(Extension(authority)), None) => {
            state.with_authorized_vault(&user, &authority, |tx| {
                credentials_in_connection(&state, &user, tx)
            })
        }
        (None, Some(Extension(authority))) => {
            state.try_with_paired_owner_review(&user.user_id, &authority, |tx, check| {
                let credentials = credentials_in_connection(&state, &user, tx)?;
                check()?;
                Ok(credentials)
            })
        }
        _ => Err("Credential is invalid or expired".into()),
    })
    .await
    .map_err(|_| ApiError::internal("Credential worker unavailable"))?
    .map_err(credential_authority_error)
}

fn credential_authority_error(error: String) -> ApiError {
    if matches!(
        error.as_str(),
        "Paired grant expired or revoked"
            | "Paired grant does not authorize this input"
            | "Paired grant is invalid"
    ) {
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "The session is no longer valid".into(),
        }
    } else {
        crate::vault_authority_error(error)
    }
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
    #[serde(default)]
    settings: Option<serde_json::Map<String, Value>>,
}
async fn save_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
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
    let stored = if crate::v4_agent::cloud_provider::kind(&provider).is_some() {
        crate::v4_agent::cloud_provider::pack(
            &provider,
            secret,
            input.settings.as_ref(),
            crate::v4_agent::cloud_provider::loopback_allowed(),
        )
        .map_err(ApiError::bad_request)?
    } else if input.settings.is_some() {
        return Err(ApiError::bad_request("Provider does not take settings"));
    } else {
        secret.to_owned()
    };
    let authority = crate::settings_local_authority(authority)?;
    let masked = mask(secret);
    let name = provider_name(&provider);
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _lease = crate::vault_admission::exclusive(&state.config().data_dir, &user.user_id)?;
        state.with_authorized_vault(&user, &authority, |tx| {
            let encrypted = vault::VaultCipher::load(&state.config().data_dir).and_then(|cipher| cipher.encrypt(&stored)).map_err(|_| "Could not encrypt credential".to_string())?;
            tx.execute("DELETE FROM api_key_vault WHERE user_id=?1 AND key_name=?2", rusqlite::params![user.user_id, name]).map_err(|_| "Could not save credential".to_string())?;
            tx.execute("INSERT INTO api_key_vault (id,user_id,key_name,key_value,created_at) VALUES (?1,?2,?3,?4,?5)", rusqlite::params![uuid::Uuid::new_v4().to_string(), user.user_id, name, encrypted, crate::iso_timestamp()]).map_err(|_| "Could not save credential".to_string())?;
            Ok(())
        })
    }).await.map_err(|_| ApiError::internal("Credential worker unavailable"))?.map_err(crate::vault_authority_error)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"provider":provider,"configured":true,"masked":masked})),
    ))
}
async fn delete_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    authority: Option<Extension<crate::auth::LocalAuthority>>,
    Path(provider): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !accepts_key(&provider) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: "Provider does not accept API keys".into(),
        });
    }
    let authority = crate::settings_local_authority(authority)?;
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        let _lease = crate::vault_admission::exclusive(&state.config().data_dir, &user.user_id)?;
        state.with_authorized_vault(&user, &authority, |tx| {
            tx.execute(
                "DELETE FROM api_key_vault WHERE user_id=?1 AND key_name=?2",
                rusqlite::params![user.user_id, provider_name(&provider)],
            )
            .map_err(|_| "Could not remove credential".to_string())?;
            Ok(())
        })
    })
    .await
    .map_err(|_| ApiError::internal("Credential worker unavailable"))?
    .map_err(crate::vault_authority_error)?;
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
        if let Some(codex_home) = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".codex")))
        {
            if let Some(cache) = read_bounded(codex_home.join("models_cache.json"), 2_000_000)
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            {
                if let Some(models) = cache["models"].as_array() {
                    let selected =
                        read_bounded(codex_home.join("config.toml"), 100_000).and_then(|config| {
                            config.lines().find_map(|line| {
                                line.trim()
                                    .strip_prefix("model =")
                                    .map(|value| value.trim().trim_matches(['\"', '\'']).to_owned())
                            })
                        });
                    let visible:Vec<_>=models.iter().filter(|model|model["visibility"]!="hide").filter_map(|model|model["slug"].as_str().filter(|slug|slug.len()<=200).map(|slug|{
                        let mut entry = json!({"id":slug,"label":model["display_name"].as_str().unwrap_or(slug),"default":selected.as_deref()==Some(slug)});
                        if let Some(levels) = model["supported_reasoning_levels"].as_array() {
                            entry["reasoningLevels"] = json!(levels.iter().filter_map(|level| level["effort"].as_str()).filter(|level| matches!(*level, "low" | "medium" | "high" | "xhigh" | "max" | "ultra")).collect::<Vec<_>>());
                        }
                        if let Some(default) = model["default_reasoning_level"].as_str() { entry["defaultReasoning"] = json!(default); }
                        entry
                    })).take(100).collect();
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
    json!({"id":provider,"label":label,"command":provider,"launchCommand":launch,"hostShell":if cfg!(windows){"cmd"}else{"posix"},"available":available,"authenticated":authenticated,"status":if available{"ready"}else{"not-installed"},"models":models(provider),"reasoningLevels":if ["codex","claude"].contains(&provider){json!(["low","medium","high","xhigh","max"])}else{json!([])},"runtime":if provider=="codex"{Some("codex")}else{None},"help":if provider=="codex"{Some("Uses local Codex. If sign-in is needed, run codex login in a terminal on this computer.")}else{None},"capabilities":{"tools":true,"nativeRuntime":true,"structured":(["claude","codex"].contains(&provider)),"durableTasks":(["codex","claude"].contains(&provider)),"learning":false,"authenticationStatus":"unknown"}})
}
async fn catalog(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let credentials =
        credential_snapshot(state.clone(), user.clone(), local.clone(), paired.clone()).await?;
    let mut agents = Vec::new();
    for (provider, label) in [
        ("codex", "Codex"),
        ("claude", "Claude Code"),
        ("gemini", "Gemini CLI"),
    ] {
        agents.push(native_state(provider, label).await);
    }
    for definition in definitions() {
        let id = definition["id"].as_str().unwrap_or_default();
        let configured = credentials.contains_key(id);
        let compatible = crate::v4_agent::supports(id);
        // Providers without a V4 adapter can never start here, so they are not offered at all.
        if !compatible {
            continue;
        }
        let runtime_available = compatible;
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
        agents.push(json!({"id":id,"label":definition["label"],"command":"terminal-v4-api","launchCommand":if compatible{launch}else{None},"hostShell":if cfg!(windows){"cmd"}else{"posix"},"runtime":if compatible{"v4"}else{"unavailable"},"available":available,"runtimeAvailable":runtime_available,"authenticated":null,"configured":configured,"status":if !compatible{"unsupported"}else if !runtime_available{"not-installed"}else if !configured{"not-configured"}else{"ready"},"models":crate::v4_agent::catalog_models(id),"reasoningLevels":crate::v4_agent::reasoning_levels(id),"capabilities":{"tools":compatible,"nativeRuntime":compatible,"structured":compatible,"durableTasks":crate::v4_agent::supports_tasks(id),"learning":compatible,"authenticationStatus":"unknown"},"help":if compatible{"Runs in V4’s own tool runtime using this account’s encrypted API key. Workspace files are available; each shell command requires approval."}else{"This provider needs an adapter or additional account configuration; it cannot launch from this host yet."}}));
    }
    #[cfg(unix)]
    {
        use crate::v4_agent::profile::Binding;
        use terminal_v4_provider_connections::Transport;
        let profiles = state
            .provider_connections()
            .public_profiles_with_published_inventory(&user)
            .await
            .map_err(|_| ApiError::internal("Saved provider connections are unavailable"))?;
        for profile in profiles["profiles"]
            .as_array()
            .ok_or_else(|| ApiError::internal("Saved provider metadata is unavailable"))?
        {
            let profile_id = profile["profileId"]
                .as_str()
                .ok_or_else(|| ApiError::internal("Saved connection ID is unavailable"))?;
            let revision = profile["revision"]
                .as_str()
                .ok_or_else(|| ApiError::internal("Saved connection revision is unavailable"))?;
            let transport = match profile["transport"].as_str() {
                Some("openai-chat") => Transport::OpenAiChat,
                Some("openai-responses") => Transport::OpenAiResponses,
                _ => {
                    return Err(ApiError::internal(
                        "Saved connection protocol is unavailable",
                    ))
                }
            };
            let id = Binding::provider_id(profile_id, revision, transport);
            if Binding::parse(&id).is_none() {
                return Err(ApiError::internal("Saved connection identity is invalid"));
            }
            let ready = profile["activation"] == "ready"
                && matches!(
                    profile["credentialState"].as_str(),
                    Some("configured" | "not-required")
                );
            let name = match (profile["provider"].as_str(), profile["mode"].as_str()) {
                (Some("lmstudio"), _) => "LM Studio local",
                (Some("actual"), Some("relay")) => "Actual relay",
                _ => "Actual local",
            };
            let inventory = &profile["modelInventory"];
            let models = inventory["models"]
                .as_array()
                .map(|models| {
                    models
                        .iter()
                        .map(|model| {
                            json!({"id":model["id"],"label":model["label"],"imageInput":false,
                    "reasoningLevels":[],"discoveryMetadata":model})
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            agents.push(json!({"id":id,"label":format!("{name} · {}",&profile_id[profile_id.len().saturating_sub(8)..]),"runtime":"v4","available":ready,"runtimeAvailable":true,"configured":ready,"status":if ready{"ready"}else{"cleanup-pending"},"launchCommand":null,"models":models,"modelInventory":inventory,"reasoningLevels":[],"connectionProfile":{"profileId":profile_id,"revision":revision,"transport":profile["transport"]},"capabilities":{"tools":true,"nativeRuntime":true,"structured":true,"durableTasks":false,"cli":false,"imageInput":false,"learning":true},"help":"Choose a model supported by this saved connection. Runs in a V4 conversation."}));
        }
    }
    // The profile actor is asynchronous; recheck before returning its owner-scoped metadata.
    credential_snapshot(state, user, local, paired).await?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(json!({"defaultAgent":"codex","agents":agents})),
    ))
}
async fn authentication(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    local: Option<Extension<crate::auth::LocalAuthority>>,
    paired: Option<Extension<crate::auth::PairedInputAuthority>>,
) -> Result<([(header::HeaderName, &'static str); 1], Json<Value>), ApiError> {
    let credentials = credential_snapshot(state, user, local, paired).await?;
    let mut providers = vec![
        json!({"id":"codex","label":"Codex","methods":["oauth"],"command":"codex login","help":"Sign in using the native Codex CLI.","configured":null}),
        json!({"id":"claude","label":"Claude Code","methods":["oauth"],"command":"claude auth login","help":"Sign in using the native Claude CLI.","configured":null}),
        json!({"id":"gemini","label":"Gemini CLI","methods":["oauth"],"command":"gemini","configured":null}),
    ];
    for definition in definitions() {
        let id = definition["id"].as_str().unwrap_or_default();
        let credential = credentials.get(id);
        let methods = definition
            .get("authMethods")
            .cloned()
            .unwrap_or_else(|| json!([definition["auth"]]));
        providers.push(json!({"id":id,"label":definition["label"],"methods":methods,"command":definition.get("oauthCommand").or_else(||definition.get("command")),"help":definition.get("oauthHelp").or_else(||definition.get("commandHelp")).or_else(||definition.get("help")),"status":if credential.is_some(){"ready"}else{"not-configured"},"configured":credential.is_some(),"masked":credential.map(|secret|mask(&crate::v4_agent::cloud_provider::api_key(id,secret))),"settings":definition.get("settings"),"configuredSettings":credential.map(|secret|crate::v4_agent::cloud_provider::public_settings(id,secret)).filter(|value|!value.is_null()),"models":definition["models"].as_array().map(Vec::len).unwrap_or(0)}));
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

    #[test]
    fn paired_storage_failure_is_not_misreported_as_a_revoked_grant() {
        assert_eq!(
            credential_authority_error("Paired grant storage unavailable".into()).status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            credential_authority_error("Paired grant expired or revoked".into()).status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn catalog_rechecks_authority_after_waiting_for_profile_lookup() {
        use std::time::Duration;
        for paired in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let state = AppState::new(AppConfig {
                data_dir: data.path().into(),
                jwt_secret: "catalog-race".into(),
                ..Default::default()
            })
            .unwrap();
            state
                .create_local_user_for_test("fixture", "fixture-password")
                .unwrap();
            let login = state
                .login("fixture", "fixture-password")
                .await
                .unwrap()
                .unwrap();
            let (grant, token) = if paired {
                let (grant, token) =
                    crate::paired_environments::synthetic_input_grant(&state, &login.user.id);
                (Some(grant), token)
            } else {
                (None, login.tokens.access_token)
            };
            let (release, enqueued) = state.provider_connections().pause_profile_lookup_for_test();
            let request = Request::builder()
                .uri("/api/agent/catalog")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            let app = crate::app(state.clone());
            let task = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
            enqueued.recv_timeout(Duration::from_secs(5)).unwrap();
            if let Some(grant) = grant {
                state
                    .lock_db()
                    .unwrap()
                    .execute("DELETE FROM paired_grants WHERE id=?1", [grant])
                    .unwrap();
            } else {
                state.logout_user(&login.user.id).unwrap();
            }
            release.send(()).unwrap();
            let response = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "paired={paired}"
            );
        }
    }

    fn state() -> AppState {
        AppState::new(AppConfig {
            data_dir: tempfile::tempdir().unwrap().keep(),
            jwt_secret: "catalog-test".into(),
            ..Default::default()
        })
        .unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn provider_key_save_and_delete_report_busy_during_owner_image_request() {
        let state = state();
        let app = router(state.clone());
        let lease = crate::vault_admission::shared(&state.config().data_dir, "owner").unwrap();
        for (method, body) in [
            ("PUT", r#"{"apiKey":"synthetic-credential"}"#),
            ("DELETE", ""),
        ] {
            let response = app
                .clone()
                .oneshot(request(
                    method,
                    "/api/agent/auth/openai-api/api-key",
                    Some("owner"),
                    body,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(json(response).await["error"], crate::vault_admission::BUSY);
        }
        drop(lease);
        let response = app
            .oneshot(request(
                "PUT",
                "/api/agent/auth/openai-api/api-key",
                Some("owner"),
                r#"{"apiKey":"synthetic-credential"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn saved_profile_catalog_is_owner_scoped_revision_bound_and_structured_only() {
        use crate::v4_agent::profile::Binding;
        use terminal_v4_provider_connections::Transport;
        let state = state();
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let profile = "10000000-0000-4000-8000-000000000001";
        let connection_routes = crate::provider_connections::routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state.clone());
        let body = serde_json::json!({"operationId":"60000000-0000-4000-8000-000000000001","expectedRevision":null,"provider":"lmstudio","mode":"local","baseUrl":"http://127.0.0.1:9/v1","auth":{"type":"bearer","credentialAction":"replace","secret":"synthetic-catalog-profile-secret"}});
        let saved = connection_routes
            .oneshot(request(
                "PUT",
                &format!("/api/agent/connections/{profile}"),
                Some(&user.user_id),
                &body.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved = json(saved).await;
        let id = Binding::provider_id(
            profile,
            saved["savedRevision"].as_str().unwrap(),
            Transport::OpenAiChat,
        );
        let owner = json(
            router(state.clone())
                .oneshot(request("GET", "/api/agent/catalog", Some("owner"), ""))
                .await
                .unwrap(),
        )
        .await;
        let other = json(
            router(state.clone())
                .oneshot(request("GET", "/api/agent/catalog", Some("other"), ""))
                .await
                .unwrap(),
        )
        .await;
        let agent = owner["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent["id"] == id)
            .expect("saved profile missing from model catalog");
        assert_eq!(agent["runtime"], "v4");
        assert_eq!(agent["available"], true);
        assert_eq!(agent["capabilities"]["structured"], true);
        assert_eq!(agent["capabilities"]["durableTasks"], false);
        assert_eq!(agent["launchCommand"], Value::Null);
        assert_eq!(agent["models"], serde_json::json!([]));
        assert_eq!(agent["reasoningLevels"], serde_json::json!([]));
        assert!(!other["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["id"] == id));
        assert!(!owner
            .to_string()
            .contains("synthetic-catalog-profile-secret"));
        assert!(state.provider_connections().shutdown().await);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn saved_profile_catalog_projects_published_inventory_without_discovery_dispatch() {
        use crate::v4_agent::profile::Binding;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use terminal_v4_provider_connections::Transport;
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let fixture = Router::new().route(
            "/v1/models",
            axum::routing::get(move || {
                observed.fetch_add(1, Ordering::SeqCst);
                async { Json(serde_json::json!({"data":[{"id":"own-discovered-selection"}]})) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let fixture = tokio::spawn(async move {
            axum::serve(listener, fixture)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let state = state();
        let connections = crate::provider_connections::routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state.clone());
        let profile = "10000000-0000-4000-8000-000000000001";
        let discovery = "50000000-0000-4000-8000-000000000001";
        let input = serde_json::json!({"operationId":"60000000-0000-4000-8000-000000000001","expectedRevision":null,"provider":"actual","mode":"local","baseUrl":base,"auth":{"type":"none"}});
        let saved = connections
            .clone()
            .oneshot(request(
                "PUT",
                &format!("/api/agent/connections/{profile}"),
                Some("owner"),
                &input.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved = json(saved).await;
        let id = Binding::provider_id(
            profile,
            saved["savedRevision"].as_str().unwrap(),
            Transport::OpenAiResponses,
        );
        for route in ["/api/agent/catalog", "/api/agent/catalog?refresh=true"] {
            let response = router(state.clone())
                .oneshot(request("GET", route, Some("owner"), ""))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = json(response).await;
            let agent = body["agents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"] == id)
                .unwrap();
            assert_eq!(agent["models"], serde_json::json!([]));
            assert_eq!(agent["modelInventory"], Value::Null);
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let response = connections
            .clone()
            .oneshot(request(
                "POST",
                &format!("/api/agent/connections/{profile}/discoveries"),
                Some("owner"),
                &serde_json::json!({"requestId":discovery}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
        loop {
            let response = connections
                .clone()
                .oneshot(request(
                    "GET",
                    &format!("/api/agent/connection-discoveries/{discovery}"),
                    Some("owner"),
                    "",
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let job = json(response).await;
            if job["status"] == "succeeded" && job["cleanupPending"] == false {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "discovery did not settle: {job}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let response = router(state.clone())
            .oneshot(request(
                "GET",
                "/api/agent/catalog?refresh=true",
                Some("owner"),
                "",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json(response).await;
        let agent = body["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap();
        assert_eq!(agent["models"][0]["id"], "own-discovered-selection");
        assert_eq!(agent["models"][0]["imageInput"], false);
        assert_eq!(
            agent["models"][0]["discoveryMetadata"]["imageInput"],
            Value::Null
        );
        assert_eq!(agent["modelInventory"]["source"], "published-discovery");
        assert_eq!(
            agent["modelInventory"]["receipt"]["inferenceVerified"],
            false
        );
        assert_eq!(agent["capabilities"]["imageInput"], false);
        assert_eq!(agent["capabilities"]["cli"], false);
        assert_eq!(agent["capabilities"]["durableTasks"], false);
        assert_eq!(agent["reasoningLevels"], serde_json::json!([]));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let other = json(
            router(state.clone())
                .oneshot(request(
                    "GET",
                    "/api/agent/catalog?refresh=true",
                    Some("other"),
                    "",
                ))
                .await
                .unwrap(),
        )
        .await;
        assert!(!other["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["id"] == id));
        let profiles = json(
            connections
                .clone()
                .oneshot(request("GET", "/api/agent/connections", Some("owner"), ""))
                .await
                .unwrap(),
        )
        .await;
        assert!(profiles["profiles"][0].get("modelInventory").is_none());
        let mut changed = input;
        changed["operationId"] = serde_json::json!("60000000-0000-4000-8000-000000000002");
        changed["expectedRevision"] = saved["savedRevision"].clone();
        let response = connections
            .clone()
            .oneshot(request(
                "PUT",
                &format!("/api/agent/connections/{profile}"),
                Some("owner"),
                &changed.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let changed = json(response).await;
        let next_id = Binding::provider_id(
            profile,
            changed["savedRevision"].as_str().unwrap(),
            Transport::OpenAiResponses,
        );
        assert_ne!(next_id, id);
        let current = json(
            router(state.clone())
                .oneshot(request(
                    "GET",
                    "/api/agent/catalog?refresh=true",
                    Some("owner"),
                    "",
                ))
                .await
                .unwrap(),
        )
        .await;
        assert!(!current["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["id"] == id));
        let next = current["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent["id"] == next_id)
            .unwrap();
        assert_eq!(next["models"], serde_json::json!([]));
        assert_eq!(next["modelInventory"], Value::Null);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(state.provider_connections().shutdown().await);
        stop.send(()).unwrap();
        fixture.await.unwrap();
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
    async fn cloud_provider_settings_are_validated_stored_encrypted_and_exposed_without_the_key() {
        let state = state();
        let app = router(state.clone());
        let put = |provider: &str, body: &str| {
            request(
                "PUT",
                &format!("/api/agent/auth/{provider}/api-key"),
                Some("owner"),
                body,
            )
        };
        for (provider, body) in [
            ("bedrock", r#"{"apiKey":"synthetic-bedrock-key"}"#),
            (
                "bedrock",
                r#"{"apiKey":"synthetic-bedrock-key","settings":{"region":"../x"}}"#,
            ),
            (
                "azure-foundry",
                r#"{"apiKey":"synthetic-azure-key","settings":{"endpoint":"https://evil.example.com","apiVersion":"2024-10-21"}}"#,
            ),
            (
                "azure-foundry",
                r#"{"apiKey":"synthetic-azure-key","settings":{"endpoint":"https://r.openai.azure.com","apiVersion":"2024-10-21","extra":"1"}}"#,
            ),
            (
                "vertex",
                r#"{"apiKey":"synthetic-vertex-key","settings":{"project":"BAD","location":"us-central1"}}"#,
            ),
            (
                "deepseek",
                r#"{"apiKey":"synthetic-provider-secret","settings":{"region":"us-west-2"}}"#,
            ),
        ] {
            let response = app.clone().oneshot(put(provider, body)).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{provider} {body}"
            );
            assert!(!json(response).await.to_string().contains("synthetic"));
        }
        let response = app
            .clone()
            .oneshot(put(
                "azure-foundry",
                r#"{"apiKey":"synthetic-azure-key-1234","settings":{"endpoint":"https://r.openai.azure.com/","apiVersion":"2024-10-21"}}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let saved = json(response).await;
        assert_eq!(saved["masked"], "****1234");
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let stored = state.list_vault_keys(&user).unwrap().remove(0).key_value;
        assert!(
            !stored.contains("synthetic-azure-key-1234") && !stored.contains("openai.azure.com")
        );
        let auth = json(
            app.clone()
                .oneshot(request("GET", "/api/agent/auth", Some("owner"), ""))
                .await
                .unwrap(),
        )
        .await;
        let azure = auth["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "azure-foundry")
            .unwrap();
        assert_eq!(azure["methods"], serde_json::json!(["api-key"]));
        assert_eq!(azure["masked"], "****1234");
        assert_eq!(
            azure["configuredSettings"],
            serde_json::json!({"endpoint":"https://r.openai.azure.com","apiVersion":"2024-10-21","authHeader":"api-key"})
        );
        assert_eq!(azure["settings"][0]["key"], "endpoint");
        assert!(!auth.to_string().contains("synthetic-azure-key-1234"));
        let catalog = json(
            app.oneshot(request("GET", "/api/agent/catalog", Some("owner"), ""))
                .await
                .unwrap(),
        )
        .await;
        let ids: Vec<_> = catalog["agents"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|agent| agent["id"].as_str())
            .collect();
        for id in ["azure-foundry", "bedrock", "vertex"] {
            assert!(ids.contains(&id), "{id}");
        }
        for id in ["copilot", "moa", "copilot-acp"] {
            assert!(!ids.contains(&id), "{id}");
        }
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
    async fn utility_provider_key_save_survives_restart_with_private_install_key() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            jwt_secret: "catalog-test".into(),
            ..Default::default()
        };
        let state = AppState::new(config.clone()).unwrap();
        let response = router(state.clone())
            .oneshot(request(
                "PUT",
                "/api/agent/auth/deepseek/api-key",
                Some("owner"),
                r#"{"apiKey":"synthetic-provider-secret"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let user = AuthenticatedUser {
            user_id: "owner".into(),
            username: "owner".into(),
        };
        let ciphertext = state.list_vault_keys(&user).unwrap().remove(0).key_value;
        assert!(vault::decrypt_secret(&ciphertext, "dev-vault-key-change-in-production").is_err());
        drop(state);
        let restarted = AppState::new(config).unwrap();
        assert_eq!(
            credentials(&restarted, &user)
                .unwrap()
                .get("deepseek")
                .map(String::as_str),
            Some("synthetic-provider-secret")
        );
        let response = router(restarted)
            .oneshot(request("GET", "/api/agent/auth", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = json(response).await;
        assert!(!payload.to_string().contains("synthetic-provider-secret"));
        let provider = payload["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["id"] == "deepseek")
            .unwrap();
        assert_eq!(provider["configured"], true);
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
            crate::vault::VaultCipher::load(&state.config().data_dir)
                .unwrap()
                .decrypt(&stored[0].key_value)
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
    async fn catalog_uses_v4_runtime_without_a_hermes_installation() {
        let response = router(state())
            .oneshot(request("GET", "/api/agent/catalog", Some("owner"), ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let catalog = json(response).await;
        let agents = catalog["agents"].as_array().unwrap();
        assert!(!agents.iter().any(|entry| entry["id"] == "hermes"));
        let api = agents
            .iter()
            .find(|entry| entry["id"] == "deepseek")
            .unwrap();
        assert_eq!(api["capabilities"]["tools"], true);
        assert_eq!(api["runtime"], "v4");
        assert_eq!(api["runtimeAvailable"], true);
        assert_eq!(api["configured"], false);
        assert_eq!(api["available"], false);
    }
    #[tokio::test]
    async fn catalog_leaves_out_providers_this_host_cannot_launch() {
        let catalog = json(
            router(state())
                .oneshot(request("GET", "/api/agent/catalog", Some("owner"), ""))
                .await
                .unwrap(),
        )
        .await;
        let agents = catalog["agents"].as_array().unwrap();
        assert!(!agents.iter().any(|agent| agent["status"] == "unsupported"
            || ["copilot", "copilot-acp", "moa"]
                .contains(&agent["id"].as_str().unwrap_or_default())));
    }
}
