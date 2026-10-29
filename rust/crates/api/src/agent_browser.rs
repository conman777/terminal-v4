use crate::{
    auth::AuthenticatedUser,
    state::AppState,
    v4_agent::browser::{self, BrowserConfig},
    ApiError,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::header,
    response::IntoResponse,
    Extension, Json, Router,
};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agent/browser", axum::routing::get(get).put(put))
        .layer(DefaultBodyLimit::max(32_768))
}
type ConfigurationResponse = ([(header::HeaderName, &'static str); 1], Json<BrowserConfig>);
async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<ConfigurationResponse, ApiError> {
    let config = browser::load_config(&state.config().data_dir, &user.user_id)
        .map_err(ApiError::internal)?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(config)))
}
async fn put(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(config): Json<BrowserConfig>,
) -> Result<axum::response::Response, ApiError> {
    let config = config.normalized().map_err(ApiError::bad_request)?;
    let previous = browser::load_config(&state.config().data_dir, &user.user_id)
        .map_err(ApiError::internal)?;
    let changed = previous.enabled != config.enabled
        || previous.executable != config.executable
        || previous.headless != config.headless
        || previous.timeout_seconds != config.timeout_seconds
        || previous.allowed_origins != config.allowed_origins;
    browser::save_config(&state.config().data_dir, &user.user_id, &config).map_err(|error| {
        if error == browser::SETTINGS_BUSY {
            ApiError {
                status: axum::http::StatusCode::SERVICE_UNAVAILABLE,
                message: error,
            }
        } else {
            ApiError::internal(error)
        }
    })?;
    let manager = state.structured_session_manager();
    let cleanup = if changed {
        manager.close_owner(&user.user_id).await
    } else {
        manager.retry_owner_cleanup(&user.user_id).await
    };
    if let Err(error) = cleanup {
        return Ok((
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(serde_json::json!({
                "error": format!("Browser configuration saved, but active agent cleanup could not be confirmed. Retry saving these settings: {error}"),
                "settingsSaved": true,
                "cleanupConfirmed": false,
                "config": config,
            })),
        ).into_response());
    }
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(config)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{issue_access_token, require_auth};
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        middleware,
    };
    use serde_json::{json, Value};
    use terminal_v4_core::AppConfig;
    use tower::ServiceExt;
    fn setup() -> (tempfile::TempDir, Router) {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(AppConfig {
            data_dir: directory.path().to_owned(),
            jwt_secret: "browser-fixture-only".into(),
            ..Default::default()
        })
        .unwrap();
        let app = routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state);
        (directory, app)
    }
    fn request(method: &str, owner: Option<&str>, body: Value) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri("/api/agent/browser")
            .header("content-type", "application/json");
        if let Some(owner) = owner {
            request = request.header(
                "authorization",
                format!(
                    "Bearer {}",
                    issue_access_token("browser-fixture-only", owner, owner)
                ),
            );
        }
        request.body(Body::from(body.to_string())).unwrap()
    }
    async fn value(response: axum::response::Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 65_536).await.unwrap()).unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn busy_image_read_keeps_settings_unsaved_and_allows_retry() {
        let (directory, app) = setup();
        let before = BrowserConfig {
            enabled: true,
            ..Default::default()
        };
        browser::save_config(directory.path(), "owner", &before).unwrap();
        let lease = browser::browser_settings_lease(directory.path(), "owner").unwrap();
        let response = app
            .clone()
            .oneshot(request("PUT", Some("owner"), json!({"enabled":false})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(value(response).await["error"]
            .as_str()
            .unwrap()
            .contains("retry"));
        assert!(
            browser::load_config(directory.path(), "owner")
                .unwrap()
                .enabled
        );
        drop(lease);
        let response = app
            .oneshot(request("PUT", Some("owner"), json!({"enabled":false})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            !browser::load_config(directory.path(), "owner")
                .unwrap()
                .enabled
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn repair_t4_removed_executable_settings_remain_readable_and_clearable() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, app) = setup();
        let executable = directory.path().join("synthetic-browser");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = json!({"enabled":false,"executable":executable,"headless":true,"timeoutSeconds":15,"allowedOrigins":[]});
        assert_eq!(
            app.clone()
                .oneshot(request("PUT", Some("owner"), config.clone()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        std::fs::remove_file(&executable).unwrap();
        let read = app
            .clone()
            .oneshot(request("GET", Some("owner"), Value::Null))
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(value(read).await, config);
        let invalid = app
            .clone()
            .oneshot(request("PUT", Some("owner"), config))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let cleared = json!({"enabled":false,"executable":null,"headless":true,"timeoutSeconds":15,"allowedOrigins":[]});
        let saved = app
            .clone()
            .oneshot(request("PUT", Some("owner"), cleared.clone()))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(value(saved).await, cleared);
        let read = app
            .oneshot(request("GET", Some("owner"), Value::Null))
            .await
            .unwrap();
        assert_eq!(value(read).await, cleared);
    }
    #[tokio::test]
    async fn browser_configuration_requires_authentication_and_stays_account_scoped() {
        let (_directory, app) = setup();
        for method in ["GET", "PUT"] {
            assert_eq!(
                app.clone()
                    .oneshot(request(method, None, json!({})))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let input = json!({"enabled":true,"headless":true,"timeoutSeconds":20,"allowedOrigins":["HTTPS://EXAMPLE.COM:443/","https://example.com","http://localhost:3000/"]});
        let response = app
            .clone()
            .oneshot(request("PUT", Some("owner-a"), input))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(
            value(response).await,
            json!({"enabled":true,"executable":null,"headless":true,"timeoutSeconds":20,"allowedOrigins":["https://example.com","http://localhost:3000"]})
        );
        let stored = value(
            app.clone()
                .oneshot(request("GET", Some("owner-a"), Value::Null))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(stored["enabled"], true);
        let other = value(
            app.oneshot(request("GET", Some("owner-b"), Value::Null))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(other["enabled"], false);
        assert_eq!(other["allowedOrigins"], json!([]));
    }
    #[tokio::test]
    async fn browser_configuration_rejects_unsafe_settings_without_replacing_valid_settings() {
        let (_directory, app) = setup();
        let response = app
            .clone()
            .oneshot(request(
                "PUT",
                Some("owner"),
                json!({"enabled":false,"allowedOrigins":["https://fixture.example"]}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        for input in [
            json!({"enabled":true,"profile":"/private/browser"}),
            json!({"enabled":true,"cookies":[]}),
            json!({"executable":"chrome --user-data-dir=/private"}),
            json!({"allowedOrigins":["file:///tmp"]}),
            json!({"timeoutSeconds":0}),
            json!({"allowedOrigins":["https://example.com/path"]}),
        ] {
            let response = app
                .clone()
                .oneshot(request("PUT", Some("owner"), input))
                .await
                .unwrap();
            assert!(
                matches!(
                    response.status(),
                    StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
                ),
                "{}",
                response.status()
            );
        }
        let stored = value(
            app.oneshot(request("GET", Some("owner"), Value::Null))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(stored["allowedOrigins"], json!(["https://fixture.example"]));
        assert_eq!(stored["enabled"], false);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn saving_browser_settings_never_launches_or_probes_the_executable() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, app) = setup();
        let executable = directory.path().join("synthetic-browser");
        let marker = directory.path().join("launched");
        std::fs::write(
            &executable,
            format!("#!/bin/sh\nprintf launched > '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let response=app.clone().oneshot(request("PUT",Some("owner"),json!({"enabled":true,"executable":executable,"allowedOrigins":["https://fixture.example"]}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .oneshot(request("GET", Some("owner"), Value::Null))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!marker.exists());
        assert!(!directory
            .path()
            .join("v4-browser")
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.path().join("profiles").exists()));
    }

    // These fixtures exercise the authenticated API -> manager cleanup seam.
    // They spawn no process, browser, network connection, or model request.
    struct RevocationController {
        data: std::path::PathBuf,
        owner: String,
        kills: std::sync::atomic::AtomicUsize,
        fail: std::sync::atomic::AtomicBool,
        blocked: std::sync::atomic::AtomicBool,
        observed_enabled: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        events: std::sync::Mutex<
            Option<tokio::sync::mpsc::UnboundedSender<terminal_v4_core::StructuredSessionEvent>>,
        >,
    }
    impl RevocationController {
        fn new(data: &std::path::Path, owner: &str) -> Self {
            Self {
                data: data.into(),
                owner: owner.into(),
                kills: std::sync::atomic::AtomicUsize::new(0),
                fail: std::sync::atomic::AtomicBool::new(false),
                blocked: std::sync::atomic::AtomicBool::new(false),
                observed_enabled: std::sync::atomic::AtomicBool::new(false),
                entered: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
                events: std::sync::Mutex::new(None),
            }
        }
        fn kills(&self) -> usize {
            self.kills.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    #[async_trait::async_trait]
    impl crate::structured::StructuredProcessController for RevocationController {
        async fn send_input(&self, _text: &str) -> Result<(), String> {
            Err("Unexpected fixture input".into())
        }
        async fn send_approval(&self, _approved: bool) -> Result<(), String> {
            Err("Unexpected fixture approval".into())
        }
        async fn interrupt(&self) -> Result<(), String> {
            self.kill().await
        }
        async fn kill(&self) -> Result<(), String> {
            use std::sync::atomic::Ordering;
            self.kills.fetch_add(1, Ordering::SeqCst);
            self.observed_enabled.store(
                browser::load_config(&self.data, &self.owner)?.enabled,
                Ordering::SeqCst,
            );
            self.entered.notify_one();
            if self.blocked.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("Synthetic retained integration cleanup failed".into());
            }
            self.events.lock().unwrap().take();
            Ok(())
        }
    }
    struct RevocationProvider {
        controllers:
            std::sync::Mutex<std::collections::VecDeque<std::sync::Arc<RevocationController>>>,
        spawns: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl crate::structured::StructuredProvider for RevocationProvider {
        fn provider_id(&self) -> &'static str {
            "browser-revocation-fixture"
        }
        fn spawn(
            &self,
            _options: crate::structured::StructuredSpawnOptions,
        ) -> Result<crate::structured::SpawnedStructuredProcess, String> {
            let controller = self
                .controllers
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("Unexpected fixture spawn")?;
            let (send, events) = tokio::sync::mpsc::unbounded_channel();
            *controller.events.lock().unwrap() = Some(send);
            self.spawns
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(crate::structured::SpawnedStructuredProcess { controller, events })
        }
    }
    struct RevocationFixture {
        _directory: tempfile::TempDir,
        _workspace: tempfile::TempDir,
        app: Router,
        manager: crate::structured::StructuredSessionManager,
        first_session: String,
        first: std::sync::Arc<RevocationController>,
        other: std::sync::Arc<RevocationController>,
        spawns: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    async fn revocation_fixture() -> RevocationFixture {
        use std::sync::{atomic::AtomicUsize, Arc, Mutex};
        let directory = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: "browser-fixture-only".into(),
            ..Default::default()
        };
        let first = Arc::new(RevocationController::new(directory.path(), "owner-a"));
        let other = Arc::new(RevocationController::new(directory.path(), "owner-b"));
        let spawns = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(RevocationProvider {
            controllers: Mutex::new([first.clone(), other.clone()].into()),
            spawns: spawns.clone(),
        });
        let manager = crate::structured::StructuredSessionManager::new_with_providers(
            config.clone(),
            vec![provider],
        );
        let state = AppState::new_with_services(config, None, manager.clone()).unwrap();
        browser::save_config(
            directory.path(),
            "owner-a",
            &BrowserConfig {
                allowed_origins: vec!["https://fixture.example".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let mut first_session = String::new();
        for owner in ["owner-a", "owner-b"] {
            let snapshot = manager
                .create_session(
                    owner,
                    workspace.path().to_str().unwrap(),
                    Some("browser-revocation-fixture"),
                    None,
                    Some("Synthetic browser revocation"),
                )
                .await
                .unwrap();
            manager
                .send_message(owner, &snapshot.id, "Synthetic held fixture")
                .await
                .unwrap();
            if owner == "owner-a" {
                first_session = snapshot.id;
            }
        }
        let app = routes()
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth))
            .with_state(state);
        RevocationFixture {
            _directory: directory,
            _workspace: workspace,
            app,
            manager,
            first_session,
            first,
            other,
            spawns,
        }
    }
    fn changed_configuration() -> Value {
        json!({"enabled":true,"allowedOrigins":["https://fixture.example"]})
    }
    #[tokio::test]
    async fn changed_browser_settings_revoke_only_the_authenticated_owners_agents() {
        use std::sync::atomic::Ordering;
        let fixture = revocation_fixture().await;
        let response = fixture
            .app
            .clone()
            .oneshot(request("PUT", Some("owner-a"), changed_configuration()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(value(response).await["enabled"], true);
        assert_eq!(fixture.first.kills(), 1);
        assert_eq!(fixture.other.kills(), 0);
        assert!(
            fixture.first.observed_enabled.load(Ordering::SeqCst),
            "Configuration must be committed before old resources are stopped"
        );
        assert_eq!(
            fixture.spawns.load(Ordering::SeqCst),
            2,
            "Settings save must not connect, relaunch, or probe"
        );
        fixture.manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn equivalent_normalized_browser_settings_do_not_cancel_healthy_agents() {
        use std::sync::atomic::Ordering;
        let fixture = revocation_fixture().await;
        let response = fixture.app.clone().oneshot(request("PUT",Some("owner-a"),json!({"enabled":false,"allowedOrigins":["HTTPS://FIXTURE.EXAMPLE:443/","https://fixture.example"]}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(fixture.first.kills(), 0);
        assert_eq!(fixture.other.kills(), 0);
        assert_eq!(fixture.spawns.load(Ordering::SeqCst), 2);
        fixture.manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn browser_settings_wait_for_cleanup_before_reporting_success() {
        use std::sync::atomic::Ordering;
        let fixture = revocation_fixture().await;
        fixture.first.blocked.store(true, Ordering::SeqCst);
        let app = fixture.app.clone();
        let saving = tokio::spawn(async move {
            app.oneshot(request("PUT", Some("owner-a"), changed_configuration()))
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            fixture.first.entered.notified(),
        )
        .await
        .unwrap();
        assert!(
            !saving.is_finished(),
            "Save must await retained integration cleanup"
        );
        assert!(fixture.first.observed_enabled.load(Ordering::SeqCst));
        assert!(fixture
            .manager
            .send_message(
                "owner-a",
                &fixture.first_session,
                "Must not relaunch while retiring"
            )
            .await
            .is_err());
        assert_eq!(fixture.spawns.load(Ordering::SeqCst), 2);
        fixture.first.release.notify_one();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), saving)
                .await
                .unwrap()
                .unwrap()
                .status(),
            StatusCode::OK
        );
        fixture.first.blocked.store(false, Ordering::SeqCst);
        fixture.manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn failed_browser_cleanup_reports_saved_configuration_and_same_save_retries() {
        use std::sync::atomic::Ordering;
        let fixture = revocation_fixture().await;
        fixture.first.fail.store(true, Ordering::SeqCst);
        let response = fixture
            .app
            .clone()
            .oneshot(request("PUT", Some("owner-a"), changed_configuration()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let saved = value(response).await;
        assert_eq!(saved["settingsSaved"], true);
        assert_eq!(saved["cleanupConfirmed"], false);
        assert_eq!(saved["config"]["enabled"], true);
        let error = saved["error"].as_str().unwrap().to_owned();
        assert!(error.contains("configuration saved"));
        assert!(error.contains("cleanup could not be confirmed"));
        assert_eq!(fixture.first.kills(), 1);
        assert_eq!(fixture.other.kills(), 0);
        assert!(
            browser::load_config(fixture._directory.path(), "owner-a")
                .unwrap()
                .enabled
        );
        assert!(fixture
            .manager
            .send_message(
                "owner-a",
                &fixture.first_session,
                "Must remain blocked after cleanup failure"
            )
            .await
            .is_err());
        assert_eq!(fixture.spawns.load(Ordering::SeqCst), 2);
        fixture.first.fail.store(false, Ordering::SeqCst);
        let response = fixture
            .app
            .clone()
            .oneshot(request("PUT", Some("owner-a"), changed_configuration()))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "An unchanged retry must finish previously failed cleanup"
        );
        assert_eq!(fixture.first.kills(), 2);
        assert_eq!(fixture.other.kills(), 0);
        let response = fixture
            .app
            .clone()
            .oneshot(request("PUT", Some("owner-a"), changed_configuration()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(fixture.first.kills(), 2);
        assert_eq!(fixture.spawns.load(Ordering::SeqCst), 2);
        fixture.manager.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn rejected_browser_saves_do_not_revoke_or_replace_configuration() {
        use std::sync::atomic::Ordering;
        let fixture = revocation_fixture().await;
        let anonymous = fixture
            .app
            .clone()
            .oneshot(request("PUT", None, changed_configuration()))
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let invalid = fixture
            .app
            .clone()
            .oneshot(request(
                "PUT",
                Some("owner-a"),
                json!({"allowedOrigins":["file:///tmp"]}),
            ))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(fixture.first.kills(), 0);
        assert_eq!(fixture.other.kills(), 0);
        assert!(
            !browser::load_config(fixture._directory.path(), "owner-a")
                .unwrap()
                .enabled
        );
        assert_eq!(fixture.spawns.load(Ordering::SeqCst), 2);
        fixture.manager.shutdown().await.unwrap();
    }
}
