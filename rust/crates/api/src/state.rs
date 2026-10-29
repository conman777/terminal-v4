use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use terminal_v4_core::{
    AppConfig, AuthMeResponse, AuthResult, Bookmark, Note, SidebarProject, TerminalSandboxInfo,
    TerminalSessionSnapshot, TerminalSessionSummary, TerminalStreamEvent, ThreadMetadata,
    TokenPair, UserPublic, UserSettings, SANDBOX_MODES,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

#[cfg(test)]
use crate::auth::issue_access_token;
use crate::auth::{issue_access_token_for_generation, AuthenticatedUser};
use crate::external_auth::{ExternalAuthProvider, ExternalAuthUser, PostgresExternalAuthProvider};
use crate::structured::StructuredSessionManager;
use crate::terminal::TerminalManager;

const EXTERNAL_AUTH_MIRROR_PASSWORD_HASH: &str = "!external-auth-mirror!";
const REFRESH_TOKEN_TTL_DAYS: i64 = 30;
const MOBILE_KEYBOARD_DEBUG_ENTRY_LIMIT: usize = 200;

#[cfg(unix)]
mod auth_admission;
#[cfg(test)]
mod auth_policy_tests;
#[cfg(unix)]
#[cfg_attr(not(any(test, feature = "supervised-input-preview")), allow(dead_code))]
pub(crate) mod owner_input;
#[cfg(test)]
mod passkey_tests;
#[cfg(test)]
mod refresh_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod utility_persistence_tests;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: AppConfig,
    db: Arc<Mutex<Connection>>,
    #[cfg(unix)]
    auth_admission: std::sync::OnceLock<Arc<auth_admission::AuthAdmission>>,
    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    supervised_input: std::sync::atomic::AtomicBool,
    #[cfg(all(test, unix))]
    logout_marker_pause:
        std::sync::Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    file_lock: Mutex<()>,
    external_auth: Option<Arc<dyn ExternalAuthProvider>>,
    terminal_manager: TerminalManager,
    structured_session_manager: StructuredSessionManager,
    provider_connections: crate::provider_connections::ProviderConnectionManager,
    process_manager: crate::processes::ProcessManager,
    stats_collector: Arc<crate::system_stats::SystemStatsCollector>,
    passkey_service: crate::passkey::PasskeyService,
    cookie_store: crate::preview::cookie_jar::CookieStore,
    port_scanner: crate::preview::port_scan::PortScanner,
    preview_log_store: crate::preview::logs::PreviewLogStore,
    preview_performance_store: crate::preview::performance::PerformanceStore,
    request_log_store: crate::preview::request_logs::RequestLogStore,
}

#[cfg(unix)]
#[derive(Clone)]
pub(crate) struct LocalAdmission {
    root: PathBuf,
    db: Arc<Mutex<Connection>>,
    fence: Arc<auth_admission::AuthAdmission>,
}

#[cfg(unix)]
impl LocalAdmission {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn accept<T, E>(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        accept: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<T, E>,
    ) -> Result<(Result<T, E>, bool), String> {
        let _fence = self.fence.acquire()?;
        let mut connection = self
            .db
            .lock()
            .map_err(|_| "Authentication database unavailable")?;
        self.fence.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        let check = || {
            self.fence.validate(&tx)?;
            let installed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |row| row.get(0)).map_err(|_| "Background installation unavailable")?;
            if installed {
                let state: Option<String> = tx
                    .query_row(
                        "SELECT state FROM background_ledger_installation WHERE id=1",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| "Background installation unavailable")?;
                if state.as_deref() != Some("ready") {
                    return Err("Background installation is incomplete".into());
                }
                let held: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM background_owner_holds WHERE owner=?1)",
                        [owner],
                        |row| row.get(0),
                    )
                    .map_err(|_| "Background owner hold unavailable")?;
                if held {
                    return Err("Owner cleanup is in progress".into());
                }
            } else {
                match std::fs::symlink_metadata(self.root.join("background-processes")) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err("Background installation identity is unavailable".into()),
                }
            }
            let current = AppState::auth_generation(&tx, owner)?;
            let (generation, _) = authority
                .valid_for(owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Credential is invalid or expired")?;
            if generation != current {
                return Err("Credential has been revoked".into());
            }
            Ok(())
        };
        check()?;
        let result = accept(&check);
        Ok((result, tx.commit().is_ok()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldPatch<T> {
    Missing,
    Null,
    Value(T),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsPatch {
    pub groq_api_key: FieldPatch<String>,
    pub preview_url: FieldPatch<String>,
    pub terminal_font_size: FieldPatch<i64>,
    pub sidebar_collapsed: FieldPatch<bool>,
    pub terminal_webgl_enabled: FieldPatch<bool>,
    pub desktop_allow_terminal_input: FieldPatch<bool>,
    pub theme: FieldPatch<String>,
    pub tab_order: FieldPatch<Vec<String>>,
    pub sandbox_default_mode: FieldPatch<String>,
    pub recent_folders: FieldPatch<Vec<String>>,
    pub pinned_folders: FieldPatch<Vec<String>>,
    pub sidebar_projects: FieldPatch<Vec<SidebarProject>>,
}

impl Default for SettingsPatch {
    fn default() -> Self {
        Self {
            groq_api_key: FieldPatch::Missing,
            preview_url: FieldPatch::Missing,
            terminal_font_size: FieldPatch::Missing,
            sidebar_collapsed: FieldPatch::Missing,
            terminal_webgl_enabled: FieldPatch::Missing,
            desktop_allow_terminal_input: FieldPatch::Missing,
            theme: FieldPatch::Missing,
            tab_order: FieldPatch::Missing,
            sandbox_default_mode: FieldPatch::Missing,
            recent_folders: FieldPatch::Missing,
            pinned_folders: FieldPatch::Missing,
            sidebar_projects: FieldPatch::Missing,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BookmarkUpdate {
    pub name: Option<String>,
    pub command: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NoteUpdate {
    pub title: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredUser {
    id: String,
    username: String,
    password_hash: String,
    created_at: String,
}

#[derive(Debug, Clone)]
struct StoredRefreshToken {
    id: String,
    user_id: String,
    expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangePasswordResult {
    Changed,
    InvalidCurrentPassword,
    ExternallyManaged,
    LocalTesting,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct PersistedTerminalSession {
    id: String,
    title: String,
    shell: String,
    cwd: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    history: Vec<TerminalStreamEvent>,
    sandbox: Option<TerminalSandboxInfo>,
    thread: Option<ThreadMetadata>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub max_history_chars: Option<usize>,
    pub max_history_events: Option<usize>,
    pub before_ts: Option<i64>,
    pub after_ts: Option<i64>,
    pub before_seq: Option<i64>,
    pub after_seq: Option<i64>,
}

impl AppState {
    /// Construct the server state with exclusive structured-session ownership.
    /// On non-Unix platforms the existing session behavior is retained.
    pub fn new_runtime(config: AppConfig) -> Result<Self, String> {
        let state = Self::new(config)?;
        #[cfg(unix)]
        {
            let manager = state.structured_session_manager();
            manager.bind_live_ownership()?;
            manager.bind_local_admission(state.local_admission()?)?;
            let installed = state.owner_cleanup_installed()?;
            let supervisor = if installed {
                crate::v4_agent::delegation_outbox::open_existing_supervisor(
                    &state.config().data_dir,
                )
            } else {
                crate::v4_agent::delegation_outbox::provision_supervisor(&state.config().data_dir)
            };
            match supervisor {
                Ok(supervisor) => manager.bind_delegation_supervisor(supervisor)?,
                Err(error) if !installed => {
                    return Err(format!(
                        "Cannot initialize owner cleanup delegation supervisor: {error}"
                    ))
                }
                Err(error) => tracing::warn!(%error, "Background delegation is unavailable"),
            }
            let cleanup = state.provision_owner_cleanup()?;
            manager.bind_owner_cleanup(cleanup)?;
            match state.open_existing_background() {
                Ok(
                    crate::v4_agent::background_process::bootstrap::ExistingInstallation::Available(
                        background,
                    ),
                ) => {
                    let background = Arc::new(background);
                    Self::recover_background_at_startup(&background);
                    manager.bind_background_processes(background)?;
                }
                Ok(
                    crate::v4_agent::background_process::bootstrap::ExistingInstallation::Absent,
                ) => match state.provision_background() {
                    Ok(background) => manager.bind_background_processes(Arc::new(background))?,
                    Err(error) => {
                        tracing::warn!(%error, "Background process provisioning failed");
                        match state.open_existing_background() {
                            Ok(crate::v4_agent::background_process::bootstrap::ExistingInstallation::Absent) => {}
                            Ok(crate::v4_agent::background_process::bootstrap::ExistingInstallation::Available(background)) => {
                                let background = Arc::new(background);
                                Self::recover_background_at_startup(&background);
                                manager.bind_background_processes(background)?
                            }
                            _ => manager.mark_background_unavailable(),
                        }
                    }
                },
                Ok(crate::v4_agent::background_process::bootstrap::ExistingInstallation::Busy) => {
                    manager.mark_background_unavailable();
                    tracing::warn!("Background process manager is owned by another server");
                }
                Err(error) => {
                    manager.mark_background_unavailable();
                    tracing::warn!(%error, "Background process manager is unavailable");
                }
            }
            manager.start_owner_cleanup_workers()?;
        }
        Ok(state)
    }

    pub fn new(config: AppConfig) -> Result<Self, String> {
        let external_auth = config
            .storage_database_url
            .clone()
            .map(PostgresExternalAuthProvider::new)
            .map(|provider| Arc::new(provider) as Arc<dyn ExternalAuthProvider>);
        Self::new_with_external_auth(config, external_auth)
    }

    pub(crate) fn new_with_external_auth(
        config: AppConfig,
        external_auth: Option<Arc<dyn ExternalAuthProvider>>,
    ) -> Result<Self, String> {
        let structured_session_manager = StructuredSessionManager::new(config.clone());
        Self::new_with_services(config, external_auth, structured_session_manager)
    }

    pub(crate) fn new_with_services(
        config: AppConfig,
        external_auth: Option<Arc<dyn ExternalAuthProvider>>,
        structured_session_manager: StructuredSessionManager,
    ) -> Result<Self, String> {
        fs::create_dir_all(&config.data_dir).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        let auth_database = auth_admission::open_database(&config.data_dir)?;
        #[cfg(unix)]
        let connection = Connection::open_with_flags(
            config.data_dir.join("terminal.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|error| error.to_string())?;
        #[cfg(not(unix))]
        let connection = Connection::open(config.data_dir.join("terminal.db"))
            .map_err(|error| error.to_string())?;
        let passkey_service = crate::passkey::PasskeyService::new(&config)?;
        let provider_connections =
            crate::provider_connections::ProviderConnectionManager::new(&config.data_dir)?;
        structured_session_manager.bind_provider_connections(provider_connections.clone())?;

        let state = Self {
            inner: Arc::new(AppStateInner {
                terminal_manager: TerminalManager::new(config.clone()),
                structured_session_manager,
                process_manager: crate::processes::ProcessManager::new(),
                stats_collector: Arc::new(crate::system_stats::SystemStatsCollector::new(
                    &config.data_dir,
                )),
                passkey_service,
                cookie_store: crate::preview::cookie_jar::CookieStore::new(),
                port_scanner: crate::preview::port_scan::PortScanner::new(),
                preview_log_store: crate::preview::logs::PreviewLogStore::new(),
                preview_performance_store: crate::preview::performance::PerformanceStore::new(),
                request_log_store: crate::preview::request_logs::RequestLogStore::new(),
                provider_connections,
                config,
                db: Arc::new(Mutex::new(connection)),
                #[cfg(unix)]
                auth_admission: std::sync::OnceLock::new(),
                #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
                supervised_input: std::sync::atomic::AtomicBool::new(false),
                #[cfg(all(test, unix))]
                logout_marker_pause: Default::default(),
                file_lock: Mutex::new(()),
                external_auth,
            }),
        };
        #[cfg(unix)]
        {
            let mut connection = state.lock_db()?;
            let admission = auth_admission::AuthAdmission::bind(
                &state.config().data_dir,
                auth_database,
                &mut connection,
            )?;
            state
                .inner
                .auth_admission
                .set(Arc::new(admission))
                .map_err(|_| "Authentication admission is already bound")?;
        }
        state.initialize_schema()?;
        Ok(state)
    }

    pub(crate) fn provider_connections(
        &self,
    ) -> &crate::provider_connections::ProviderConnectionManager {
        &self.inner.provider_connections
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    #[cfg(unix)]
    pub(crate) fn local_admission(&self) -> Result<LocalAdmission, String> {
        Ok(LocalAdmission {
            root: self
                .config()
                .data_dir
                .canonicalize()
                .map_err(|_| "Authentication root unavailable")?,
            db: self.inner.db.clone(),
            fence: self
                .inner
                .auth_admission
                .get()
                .ok_or("Authentication admission unavailable")?
                .clone(),
        })
    }

    #[cfg(unix)]
    fn open_existing_background(
        &self,
    ) -> Result<crate::v4_agent::background_process::bootstrap::ExistingInstallation, String> {
        let fence = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _guard = fence.acquire()?;
        let db = self.lock_db()?;
        fence.validate(&db)?;
        let result = crate::v4_agent::background_process::bootstrap::open_existing(
            &self.config().data_dir,
            &db,
        )?;
        fence.validate(&db)?;
        Ok(result)
    }

    #[cfg(unix)]
    fn recover_background_at_startup(
        background: &Arc<crate::v4_agent::background_process::BackgroundProcesses>,
    ) {
        let background = background.clone();
        let outcome = std::thread::Builder::new()
            .name("background-recovery".into())
            .spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?
                    .block_on(background.recover_unconfirmed())
            })
            .map_err(|error| error.to_string())
            .and_then(|handle| {
                handle
                    .join()
                    .map_err(|_| "Background recovery stopped unexpectedly".to_string())
            })
            .and_then(|result| result);
        match outcome {
            Ok(report) => tracing::info!(
                killed = report.killed,
                already_stopped = report.already_stopped,
                unresolved = report.unresolved,
                "Background process recovery finished"
            ),
            Err(error) => tracing::warn!(%error, "Background process recovery failed"),
        }
    }

    #[cfg(unix)]
    fn provision_background(
        &self,
    ) -> Result<crate::v4_agent::background_process::BackgroundProcesses, String> {
        let fence = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _guard = fence.acquire()?;
        let mut db = self.lock_db()?;
        fence.validate(&db)?;
        let result = crate::v4_agent::background_process::bootstrap::open_or_provision(
            &self.config().data_dir,
            &mut db,
        )?;
        fence.validate(&db)?;
        Ok(result)
    }

    #[cfg(unix)]
    fn owner_cleanup_installed(&self) -> Result<bool, String> {
        let fence = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _guard = fence.acquire()?;
        let db = self.lock_db()?;
        fence.validate(&db)?;
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='structured_cleanup_version')", [], |row| row.get(0))
            .map_err(|_| "Owner cleanup installation unavailable")?;
        if !exists {
            return Ok(false);
        }
        match db
            .query_row(
                "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "Owner cleanup installation unavailable")?
        {
            0 => Ok(false),
            1 | 2 | 3 | 4 => Ok(true),
            _ => Err("Unsupported owner cleanup installation".into()),
        }
    }

    #[cfg(unix)]
    pub(crate) fn provision_owner_cleanup(
        &self,
    ) -> Result<Arc<crate::structured::owner_cleanup::OwnerCleanup>, String> {
        let fence = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?
            .clone();
        {
            let _guard = fence.acquire()?;
            let mut db = self.lock_db()?;
            fence.validate(&db)?;
            let tx = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|_| "Owner cleanup installation unavailable")?;
            let has_version: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='structured_cleanup_version')", [], |row| row.get(0)).map_err(|_| "Owner cleanup installation unavailable")?;
            if !has_version {
                tx.execute_batch("ALTER TABLE auth_admission_identity ADD COLUMN structured_cleanup_version INTEGER NOT NULL DEFAULT 0").map_err(|_| "Cannot reserve owner cleanup installation")?;
            }
            let version: i64 = tx
                .query_row(
                    "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "Owner cleanup installation unavailable")?;
            if version == 0 {
                let existing: i64 = tx.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('structured_owner_holds','structured_owner_cleanup_receipts','structured_owner_delegation_receipts','structured_owner_cleanup_issues','structured_owner_background_reviews','structured_owner_delegation_reviews')", [], |row| row.get(0)).map_err(|_| "Owner cleanup installation unavailable")?;
                if existing != 0 {
                    return Err("Owner cleanup installation is incomplete".into());
                }
                tx.execute_batch("CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY,request TEXT NOT NULL); CREATE TABLE structured_owner_cleanup_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,lease_epoch TEXT NOT NULL); CREATE TABLE structured_owner_delegation_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,supervisor_instance TEXT NOT NULL,outbox_identity TEXT NOT NULL)").map_err(|_| "Cannot initialize owner cleanup")?;
            } else if version != 1 && version != 2 && version != 3 && version != 4 {
                return Err("Unsupported owner cleanup installation".into());
            }
            tx.prepare("SELECT owner,request FROM structured_owner_holds LIMIT 0")
                .map_err(|_| "Owner cleanup holds are unavailable")?;
            tx.prepare(
                "SELECT owner,request,lease_epoch FROM structured_owner_cleanup_receipts LIMIT 0",
            )
            .map_err(|_| "Owner cleanup receipts are unavailable")?;
            tx.prepare("SELECT owner,request,supervisor_instance,outbox_identity FROM structured_owner_delegation_receipts LIMIT 0").map_err(|_| "Delegation cleanup receipts are unavailable")?;
            if version <= 1 {
                tx.execute_batch("CREATE TABLE structured_owner_cleanup_issues(owner TEXT NOT NULL,request TEXT NOT NULL,resource TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(owner,request,resource))")
                    .map_err(|_| "Cannot migrate owner cleanup diagnostics")?;
            }
            tx.prepare(
                "SELECT owner,request,resource,code FROM structured_owner_cleanup_issues LIMIT 0",
            )
            .map_err(|_| "Owner cleanup diagnostics are unavailable")?;
            if version <= 2 {
                tx.execute_batch("CREATE TABLE structured_owner_background_reviews(owner TEXT NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,count INTEGER NOT NULL,ledger_binding BLOB NOT NULL,PRIMARY KEY(owner,operation))")
                    .map_err(|_| "Cannot migrate background review audit")?;
            }
            tx.prepare("SELECT owner,request,operation,count,ledger_binding FROM structured_owner_background_reviews LIMIT 0")
                .map_err(|_| "Background review audit is unavailable")?;
            if version <= 3 {
                tx.execute_batch("CREATE TABLE structured_owner_delegation_reviews(owner TEXT NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,child_operation TEXT NOT NULL,task TEXT NOT NULL,child_session TEXT NOT NULL,outbox_identity TEXT NOT NULL,PRIMARY KEY(owner,operation),UNIQUE(owner,request,child_operation)); UPDATE auth_admission_identity SET structured_cleanup_version=4 WHERE id=1")
                    .map_err(|_| "Cannot migrate delegation review audit")?;
            }
            tx.prepare("SELECT owner,request,operation,child_operation,task,child_session,outbox_identity FROM structured_owner_delegation_reviews LIMIT 0")
                .map_err(|_| "Delegation review audit is unavailable")?;
            fence.validate(&tx)?;
            tx.commit()
                .map_err(|_| "Cannot commit owner cleanup installation")?;
        }
        let acquire_fence = fence.clone();
        let validate_fence = fence;
        let acquire: crate::structured::owner_cleanup::FenceAcquire = Arc::new(move || {
            Ok(Box::new(acquire_fence.acquire()?) as crate::structured::owner_cleanup::FenceGuard)
        });
        let validate: crate::structured::owner_cleanup::FenceValidate =
            Arc::new(move |db| validate_fence.validate(db));
        let root = self
            .config()
            .data_dir
            .canonicalize()
            .map_err(|_| "Authentication root unavailable")?;
        Ok(Arc::new(
            crate::structured::owner_cleanup::OwnerCleanup::bind_shared(
                root,
                self.inner.db.clone(),
                acquire,
                validate,
            )?,
        ))
    }

    pub fn terminal_manager(&self) -> TerminalManager {
        self.inner.terminal_manager.clone()
    }

    pub fn cookie_store(&self) -> &crate::preview::cookie_jar::CookieStore {
        &self.inner.cookie_store
    }

    pub fn port_scanner(&self) -> &crate::preview::port_scan::PortScanner {
        &self.inner.port_scanner
    }

    pub fn preview_log_store(&self) -> &crate::preview::logs::PreviewLogStore {
        &self.inner.preview_log_store
    }

    pub fn preview_performance_store(&self) -> &crate::preview::performance::PerformanceStore {
        &self.inner.preview_performance_store
    }

    pub fn request_log_store(&self) -> &crate::preview::request_logs::RequestLogStore {
        &self.inner.request_log_store
    }

    pub fn process_manager(&self) -> &crate::processes::ProcessManager {
        &self.inner.process_manager
    }

    pub fn stats_collector(&self) -> Arc<crate::system_stats::SystemStatsCollector> {
        self.inner.stats_collector.clone()
    }

    pub fn structured_session_manager(&self) -> StructuredSessionManager {
        self.inner.structured_session_manager.clone()
    }

    pub fn passkey_service(&self) -> crate::passkey::PasskeyService {
        self.inner.passkey_service.clone()
    }

    pub fn auth_me(&self, user: &AuthenticatedUser) -> AuthMeResponse {
        AuthMeResponse {
            id: user.user_id.clone(),
            username: user.username.clone(),
        }
    }

    pub async fn login(
        &self,
        identifier: &str,
        password: &str,
    ) -> Result<Option<AuthResult>, String> {
        let Some(user) = self.get_user_by_username(identifier)? else {
            return self.login_external(identifier, password).await;
        };
        if is_external_auth_mirror_user(&user) {
            return self.login_external(identifier, password).await;
        }
        if user.password_hash == crate::local_testing::PASSWORD_MARKER {
            return Ok(None);
        }

        let is_valid = verify(password, &user.password_hash).map_err(|error| error.to_string())?;
        if !is_valid {
            return Ok(None);
        }

        if crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &to_public_user(&user).username,
        )
        .is_err()
        {
            return Ok(None);
        }
        self.issue_auth_result(&user).map(Some)
    }

    pub(crate) fn login_local_testing(&self, username: &str) -> Result<AuthResult, String> {
        if !crate::local_testing::enabled(self) {
            return Err("Local testing is disabled".into());
        }
        crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            username,
        )?;
        if let Some(user) = self.get_user_by_username(username)? {
            if user.password_hash == crate::local_testing::PASSWORD_MARKER
                && user.id.starts_with(crate::local_testing::ACCOUNT_PREFIX)
            {
                return self.issue_auth_result(&user);
            }
        }
        let stored_username = format!("{}{username}", crate::local_testing::USERNAME_PREFIX);
        {
            let connection = self.lock_db()?;
            let now = iso_timestamp();
            connection.execute(
                "INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(username) DO NOTHING",
                params![format!("{}{}",crate::local_testing::ACCOUNT_PREFIX,Uuid::new_v4()),stored_username,crate::local_testing::PASSWORD_MARKER,now,now],
            ).map_err(|error| error.to_string())?;
        }
        let user = self
            .get_user_by_username(&stored_username)?
            .ok_or("Could not open this testing account")?;
        if user.password_hash != crate::local_testing::PASSWORD_MARKER
            || !user.id.starts_with(crate::local_testing::ACCOUNT_PREFIX)
        {
            return Err("This testing profile could not be opened safely".into());
        }
        self.issue_auth_result(&user)
    }

    pub async fn refresh_auth(&self, refresh_token: &str) -> Result<Option<AuthResult>, String> {
        self.delete_expired_refresh_tokens()?;
        let token_hash = hash_token(refresh_token);
        let Some(stored_token) = self.get_refresh_token_by_hash(&token_hash)? else {
            return Ok(None);
        };
        let expires_at = OffsetDateTime::parse(&stored_token.expires_at, &Rfc3339)
            .map_err(|error| error.to_string())?;
        if expires_at < OffsetDateTime::now_utc() {
            self.delete_refresh_token(&stored_token.id)?;
            return Ok(None);
        }

        let Some(user) = self.get_user_by_id(&stored_token.user_id)? else {
            return self.refresh_external(stored_token).await;
        };
        if is_external_auth_mirror_user(&user) {
            return self.refresh_external(stored_token).await;
        }
        if user.password_hash == crate::local_testing::PASSWORD_MARKER
            && !crate::local_testing::enabled(self)
        {
            return Ok(None);
        }

        self.rotate_refresh_token(&stored_token, to_public_user(&user))
    }

    pub fn logout_user(&self, user_id: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            let owner_guard = owner_input::acquire(
                &self.inner.config.data_dir,
                user_id,
                std::time::Duration::from_secs(3),
            )?;
            self.logout_user_with_guard(user_id, Some(&owner_guard))
                .map(|_| ())
        }
        #[cfg(not(unix))]
        {
            self.logout_user_with_guard(user_id).map(|_| ())
        }
    }

    fn logout_user_with_guard(
        &self,
        user_id: &str,
        #[cfg(unix)] owner_guard: Option<&owner_input::OwnerInputGuard>,
    ) -> Result<bool, String> {
        #[cfg(unix)]
        let _fence = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?
            .acquire()?;
        let mut connection = self.lock_db()?;
        #[cfg(unix)]
        self.inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?
            .validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            let installed = owner_input::installed(&transaction)?;
            #[cfg(test)]
            let pause = self.inner.logout_marker_pause.lock().unwrap().take();
            #[cfg(test)]
            if let Some((entered, release)) = pause {
                let _ = entered.send(());
                let _ = release.recv();
            }
            if installed && owner_guard.is_none() {
                return Ok(false);
            }
            if installed {
                owner_guard
                    .ok_or("Input owner lock unavailable")?
                    .bind(&transaction)?;
            }
        }
        #[cfg(unix)]
        {
            let has_version: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('auth_admission_identity') WHERE name='structured_cleanup_version')",
                [],
                |row| row.get(0),
            ).map_err(|_| "Owner cleanup installation unavailable")?;
            let version: i64 = if has_version {
                transaction
                    .query_row(
                        "SELECT structured_cleanup_version FROM auth_admission_identity WHERE id=1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|_| "Owner cleanup installation unavailable")?
            } else {
                0
            };
            if version == 2 || version == 3 || version == 4 {
                let request = uuid::Uuid::new_v4();
                crate::v4_agent::background_owner_gate::hold_logout_if_installed_with_request(
                    &transaction,
                    user_id,
                    &request.to_string(),
                )?;
                crate::structured::owner_cleanup::OwnerCleanup::hold_in_transaction(
                    &transaction,
                    user_id,
                    request,
                )?;
            } else if version == 0 {
                crate::v4_agent::background_owner_gate::hold_logout_if_installed(
                    &transaction,
                    user_id,
                )?;
            } else {
                return Err("Unsupported owner cleanup installation".into());
            }
        }
        transaction
            .execute(
                "DELETE FROM refresh_tokens WHERE user_id = ?",
                params![user_id],
            )
            .map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO auth_generations (user_id, generation) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET generation = generation + 1", params![user_id]).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        self.inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?
            .validate(&transaction)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(true)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn enable_supervised_input_for_test(&self) {
        self.install_owner_input_protocol()
            .expect("Cannot initialize supervised input fixture");
        self.inner
            .supervised_input
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(all(test, unix))]
    pub(crate) fn pause_logout_marker_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (entered, wait_entered) = std::sync::mpsc::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        *self.inner.logout_marker_pause.lock().unwrap() = Some((entered, wait_release));
        (wait_entered, release)
    }

    #[cfg(all(unix, feature = "supervised-input-preview"))]
    pub fn enable_supervised_input_loopback_fixture(&self) -> Result<(), String> {
        if !crate::local_testing::enabled(self) {
            return Err("Supervised input fixture requires loopback local-testing mode".into());
        }
        self.install_owner_input_protocol()?;
        self.inner
            .supervised_input
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    fn install_owner_input_protocol(&self) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        owner_input::install(&tx)?;
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input admission installation unavailable".into())
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    pub(crate) fn supervised_input_enabled(&self) -> bool {
        self.inner
            .supervised_input
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(unix)]
    pub(crate) fn input_installation_active(&self) -> Result<bool, String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction()
            .map_err(|_| "Authentication admission unavailable")?;
        let installed = owner_input::installed(&tx)?;
        admission.validate(&tx)?;
        Ok(installed)
    }

    #[cfg(unix)]
    pub(crate) fn verify_owner_input_guard(
        &self,
        guard: &owner_input::OwnerInputGuard,
    ) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        if owner_input::installed(&tx)? {
            guard.bind(&tx)?;
        }
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input admission unavailable".to_string())
    }

    #[cfg(unix)]
    pub(crate) fn prepare_legacy_input_guard(
        &self,
        owner: &str,
        authority: Option<&crate::auth::LocalAuthority>,
        guard: &owner_input::OwnerInputGuard,
        session: &str,
    ) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        if let Some(authority) = authority {
            let current = Self::auth_generation(&tx, owner)?;
            let (generation, _) = authority
                .valid_for(owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Credential is invalid or expired")?;
            if generation != current {
                return Err("Credential has been revoked".into());
            }
        }
        if owner_input::installed(&tx)? {
            guard.bind(&tx)?;
            if guard.has_unresolved(&tx, session)? {
                return Err(
                    "An earlier input operation needs review before sending more input".into(),
                );
            }
        }
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input admission unavailable".to_string())
    }

    #[cfg(unix)]
    pub(crate) fn acquire_input_guard(
        &self,
        owner: &str,
    ) -> Result<owner_input::OwnerInputGuard, String> {
        owner_input::acquire(
            &self.inner.config.data_dir,
            owner,
            std::time::Duration::from_secs(3),
        )
    }

    #[cfg(unix)]
    pub(crate) fn try_acquire_input_guard(
        &self,
        owner: &str,
    ) -> Result<owner_input::OwnerInputGuard, String> {
        owner_input::acquire(
            &self.inner.config.data_dir,
            owner,
            std::time::Duration::ZERO,
        )
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    pub(crate) fn validate_input_guard(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        guard: &owner_input::OwnerInputGuard,
        session: &str,
        operation: &str,
        reserved: bool,
    ) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        let current = Self::auth_generation(&tx, owner)?;
        let (generation, _) = authority
            .valid_for(owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Credential is invalid or expired")?;
        if generation != current {
            return Err("Credential has been revoked".into());
        }
        let now = crate::v4_agent::interaction::now_ms();
        if reserved {
            guard.activate(&tx, session, operation, now)?;
        } else {
            guard.claim(&tx, session, operation, now)?;
        }
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Authentication admission unavailable".into())
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    pub(crate) fn validate_native_owner_guard(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        guard: &owner_input::OwnerInputGuard,
    ) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        let current = Self::auth_generation(&tx, owner)?;
        let (generation, _) = authority
            .valid_for(owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Credential is invalid or expired")?;
        if generation != current {
            return Err("Credential has been revoked".into());
        }
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Authentication admission unavailable".into())
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    pub(crate) fn issue_input_operation(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        session: &str,
        incarnation: &str,
        generation: u64,
    ) -> Result<(String, String), String> {
        let guard = self.acquire_input_guard(owner)?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        let current = Self::auth_generation(&tx, owner)?;
        let (credential_generation, _) = authority
            .valid_for(owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Credential is invalid or expired")?;
        if credential_generation != current {
            return Err("Credential has been revoked".into());
        }
        let now = crate::v4_agent::interaction::now_ms();
        let (operation, token) = owner_input::issue(
            &self.inner.config.jwt_secret,
            owner,
            session,
            incarnation,
            generation,
            now,
        )?;
        guard.reserve(&tx, session, &operation, now)?;
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input issuance is uncertain".to_string())?;
        Ok((operation, token))
    }

    #[cfg(all(unix, any(test, feature = "supervised-input-preview")))]
    pub(crate) fn finish_input_guard(
        &self,
        guard: &owner_input::OwnerInputGuard,
        session: &str,
        operation: &str,
        delivered: bool,
        legacy: bool,
    ) -> Result<(), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        guard.finish(
            &tx,
            session,
            operation,
            if delivered && legacy {
                "acknowledged"
            } else if delivered {
                "delivered"
            } else {
                "uncertain"
            },
        )?;
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input receipt outcome is uncertain".into())
    }

    #[cfg(unix)]
    pub(crate) fn input_receipt(
        &self,
        owner: &str,
        session: &str,
        operation: &str,
    ) -> Result<Option<String>, String> {
        let connection = self.lock_db()?;
        owner_input::receipt(&connection, owner, session, operation)
    }

    #[cfg(unix)]
    pub(crate) fn list_input_receipts(
        &self,
        owner: &str,
        session: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let connection = self.lock_db()?;
        owner_input::receipts(&connection, owner, session)
    }

    #[cfg(unix)]
    pub(crate) fn list_unresolved_input_receipts(
        &self,
        owner: &str,
        after: i64,
    ) -> Result<(Vec<(String, String, String)>, Option<i64>), String> {
        let connection = self.lock_db()?;
        owner_input::unresolved_receipts(&connection, owner, after)
    }

    #[cfg(unix)]
    pub(crate) fn input_watermark(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
    ) -> Result<i64, String> {
        let guard = self.acquire_input_guard(owner)?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        let current = Self::auth_generation(&tx, owner)?;
        let (generation, _) = authority
            .valid_for(owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Credential is invalid or expired")?;
        if generation != current {
            return Err("Credential has been revoked".into());
        }
        let cutoff = guard.advance_watermark(&tx, crate::v4_agent::interaction::now_ms())?;
        admission.validate(&tx)?;
        tx.commit().map_err(|_| "Input watermark is uncertain")?;
        Ok(cutoff)
    }

    #[cfg(unix)]
    pub(crate) fn review_input_receipt(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        session: &str,
        operation: &str,
    ) -> Result<String, String> {
        let guard = self.acquire_input_guard(owner)?;
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        guard.bind(&tx)?;
        let current = Self::auth_generation(&tx, owner)?;
        let (generation, _) = authority
            .valid_for(owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Credential is invalid or expired")?;
        if generation != current {
            return Err("Credential has been revoked".into());
        }
        let status = guard.review(&tx, session, operation)?;
        admission.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Input receipt review is uncertain".to_string())?;
        Ok(status)
    }

    pub(crate) fn validate_auth_generation(
        &self,
        user_id: &str,
        generation: i64,
    ) -> Result<(), String> {
        let connection = self.lock_db()?;
        let current = Self::auth_generation(&connection, user_id)?;
        if current != generation {
            return Err("Token has been revoked".into());
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn accept_with_local_authority<T, E>(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        accept: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<T, E>,
    ) -> Result<(Result<T, E>, bool), String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut connection = self.lock_db()?;
        admission.validate(&connection)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        let check = || {
            admission.validate(&transaction)?;
            let current = Self::auth_generation(&transaction, owner)?;
            let (generation, _) = authority
                .valid_for(owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Credential is invalid or expired")?;
            if generation != current {
                return Err("Credential has been revoked".into());
            }
            Ok(())
        };
        check()?;
        let result = accept(&check);
        let committed = transaction.commit().is_ok();
        Ok((result, committed))
    }

    #[cfg(unix)]
    pub(crate) fn with_owner_review<T>(
        &self,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        review: impl FnOnce(
            &rusqlite::Transaction<'_>,
            &dyn Fn() -> Result<(), String>,
        ) -> Result<T, String>,
    ) -> Result<T, String> {
        let admission = self
            .inner
            .auth_admission
            .get()
            .ok_or("Authentication admission unavailable")?;
        let _fence = admission.acquire()?;
        let mut db = self.lock_db()?;
        admission.validate(&db)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Authentication admission unavailable")?;
        let check = || {
            admission.validate(&tx)?;
            let current = Self::auth_generation(&tx, owner)?;
            let (generation, _) = authority
                .valid_for(owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Credential is invalid or expired")?;
            if generation != current {
                return Err("Credential has been revoked".into());
            }
            Ok(())
        };
        check()?;
        let result = review(&tx, &check)?;
        tx.commit()
            .map_err(|_| "Owner review outcome is uncertain")?;
        Ok(result)
    }

    fn auth_generation(connection: &Connection, user_id: &str) -> Result<i64, String> {
        connection
            .query_row(
                "SELECT COALESCE((SELECT generation FROM auth_generations WHERE user_id = ?), 0)",
                params![user_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn change_password(
        &self,
        user: &AuthenticatedUser,
        current_password: &str,
        new_password: &str,
    ) -> Result<ChangePasswordResult, String> {
        let Some(stored_user) = self.get_user_by_id(&user.user_id)? else {
            return Ok(ChangePasswordResult::InvalidCurrentPassword);
        };
        if is_external_auth_mirror_user(&stored_user) {
            return Ok(ChangePasswordResult::ExternallyManaged);
        }
        if stored_user.password_hash == crate::local_testing::PASSWORD_MARKER {
            return Ok(ChangePasswordResult::LocalTesting);
        }

        let is_valid = verify(current_password, &stored_user.password_hash)
            .map_err(|error| error.to_string())?;
        if !is_valid {
            return Ok(ChangePasswordResult::InvalidCurrentPassword);
        }

        let password_hash = hash(new_password, DEFAULT_COST).map_err(|error| error.to_string())?;
        let connection = self.lock_db()?;
        connection
            .execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                params![password_hash, iso_timestamp(), user.user_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM refresh_tokens WHERE user_id = ?",
                params![user.user_id],
            )
            .map_err(|error| error.to_string())?;

        Ok(ChangePasswordResult::Changed)
    }

    #[cfg(test)]
    pub fn create_local_user_for_test(
        &self,
        username: &str,
        password: &str,
    ) -> Result<UserPublic, String> {
        let password_hash = hash(password, DEFAULT_COST).map_err(|error| error.to_string())?;
        let user = StoredUser {
            id: Uuid::new_v4().to_string(),
            username: username.to_string(),
            password_hash,
            created_at: iso_timestamp(),
        };
        let connection = self.lock_db()?;
        connection
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                params![
                    user.id,
                    user.username,
                    user.password_hash,
                    user.created_at,
                    iso_timestamp()
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(to_public_user(&user))
    }

    pub(crate) fn transcription_api_key(
        &self,
        user: &AuthenticatedUser,
    ) -> Result<Option<String>, String> {
        self.lock_db()?
            .query_row(
                "SELECT groq_api_key FROM user_settings WHERE user_id = ?",
                params![user.user_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|error| error.to_string())
    }

    pub fn get_settings(&self, user: &AuthenticatedUser) -> Result<UserSettings, String> {
        let connection = self.lock_db()?;
        let row = connection
            .query_row(
                "SELECT groq_api_key, preview_url, terminal_font_size, sidebar_collapsed, terminal_webgl_enabled, desktop_allow_terminal_input, theme, tab_order, sandbox_default_mode, recent_folders, pinned_folders, sidebar_projects FROM user_settings WHERE user_id = ?",
                params![user.user_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;

        let Some((
            groq_api_key,
            preview_url,
            terminal_font_size,
            sidebar_collapsed,
            terminal_webgl_enabled,
            desktop_allow_terminal_input,
            theme,
            tab_order,
            sandbox_default_mode,
            recent_folders,
            pinned_folders,
            sidebar_projects,
        )) = row
        else {
            return Ok(UserSettings {
                groq_api_key: None,
                has_groq_api_key: false,
                preview_url: None,
                terminal_font_size: None,
                sidebar_collapsed: false,
                terminal_webgl_enabled: None,
                desktop_allow_terminal_input: None,
                theme: "dark".to_string(),
                tab_order: None,
                sandbox_default_mode: "off".to_string(),
                recent_folders: None,
                pinned_folders: None,
                sidebar_projects: None,
            });
        };

        Ok(UserSettings {
            groq_api_key: groq_api_key.as_deref().map(mask_api_key),
            has_groq_api_key: groq_api_key.is_some(),
            preview_url,
            terminal_font_size,
            sidebar_collapsed: sidebar_collapsed.unwrap_or(0) == 1,
            terminal_webgl_enabled: terminal_webgl_enabled.map(|value| value == 1),
            desktop_allow_terminal_input: desktop_allow_terminal_input.map(|value| value == 1),
            theme: theme.unwrap_or_else(|| "dark".to_string()),
            tab_order: deserialize_array(tab_order)?,
            sandbox_default_mode: normalize_sandbox_mode(sandbox_default_mode),
            recent_folders: deserialize_array(recent_folders)?,
            pinned_folders: deserialize_array(pinned_folders)?,
            sidebar_projects: deserialize_array(sidebar_projects)?,
        })
    }

    pub fn update_settings(
        &self,
        user: &AuthenticatedUser,
        patch: SettingsPatch,
    ) -> Result<(), String> {
        self.ensure_user_row(user)?;

        let mut connection = self.lock_db()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let now = iso_timestamp();

        transaction
            .execute(
                "INSERT OR IGNORE INTO user_settings (user_id, groq_api_key, preview_url, terminal_font_size, sidebar_collapsed, terminal_webgl_enabled, desktop_allow_terminal_input, theme, tab_order, sandbox_default_mode, recent_folders, pinned_folders, sidebar_projects, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    user.user_id,
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<i64>::None,
                    0_i64,
                    Option::<i64>::None,
                    0_i64,
                    "dark",
                    Option::<String>::None,
                    "off",
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;

        update_text_patch(
            &transaction,
            &user.user_id,
            "groq_api_key",
            &patch.groq_api_key,
        )?;
        update_text_patch(
            &transaction,
            &user.user_id,
            "preview_url",
            &patch.preview_url,
        )?;
        update_i64_patch(
            &transaction,
            &user.user_id,
            "terminal_font_size",
            &patch.terminal_font_size,
        )?;
        update_bool_patch(
            &transaction,
            &user.user_id,
            "sidebar_collapsed",
            &patch.sidebar_collapsed,
        )?;
        update_bool_patch(
            &transaction,
            &user.user_id,
            "terminal_webgl_enabled",
            &patch.terminal_webgl_enabled,
        )?;
        update_bool_patch(
            &transaction,
            &user.user_id,
            "desktop_allow_terminal_input",
            &patch.desktop_allow_terminal_input,
        )?;
        update_text_patch(&transaction, &user.user_id, "theme", &patch.theme)?;
        update_json_patch(&transaction, &user.user_id, "tab_order", &patch.tab_order)?;
        update_text_patch(
            &transaction,
            &user.user_id,
            "sandbox_default_mode",
            &patch.sandbox_default_mode,
        )?;
        update_json_patch(
            &transaction,
            &user.user_id,
            "recent_folders",
            &patch.recent_folders,
        )?;
        update_json_patch(
            &transaction,
            &user.user_id,
            "pinned_folders",
            &patch.pinned_folders,
        )?;
        update_json_patch(
            &transaction,
            &user.user_id,
            "sidebar_projects",
            &patch.sidebar_projects,
        )?;
        transaction
            .execute(
                "UPDATE user_settings SET updated_at = ? WHERE user_id = ?",
                params![iso_timestamp(), user.user_id],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn list_bookmarks(&self, user: &AuthenticatedUser) -> Result<Vec<Bookmark>, String> {
        let _file_lock = self.lock_files()?;
        let path = self.bookmarks_path(&user.user_id)?;
        let bookmarks = load_bookmarks_from_path(&path)?;
        if !path.try_exists().map_err(|error| error.to_string())? {
            write_json_file(&path, &bookmarks)?;
        }

        Ok(bookmarks)
    }

    pub fn create_bookmark(
        &self,
        user: &AuthenticatedUser,
        name: String,
        command: String,
        category: String,
    ) -> Result<Bookmark, String> {
        let _file_lock = self.lock_files()?;
        let path = self.bookmarks_path(&user.user_id)?;
        let mut bookmarks = load_bookmarks_from_path(&path)?;

        let bookmark = Bookmark {
            id: Uuid::new_v4().to_string(),
            name,
            command,
            category,
            created_at: iso_timestamp(),
            updated_at: None,
        };
        bookmarks.push(bookmark.clone());
        write_json_file(&path, &bookmarks)?;
        Ok(bookmark)
    }

    pub fn update_bookmark(
        &self,
        user: &AuthenticatedUser,
        bookmark_id: &str,
        updates: BookmarkUpdate,
    ) -> Result<Option<Bookmark>, String> {
        let _file_lock = self.lock_files()?;
        let path = self.bookmarks_path(&user.user_id)?;
        let mut bookmarks = load_bookmarks_from_path(&path)?;
        let Some(bookmark) = bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.id == bookmark_id)
        else {
            return Ok(None);
        };

        if let Some(name) = updates.name {
            bookmark.name = name;
        }
        if let Some(command) = updates.command {
            bookmark.command = command;
        }
        if let Some(category) = updates.category {
            bookmark.category = category;
        }
        bookmark.updated_at = Some(iso_timestamp());
        let updated = bookmark.clone();
        write_json_file(&path, &bookmarks)?;
        Ok(Some(updated))
    }

    pub fn delete_bookmark(
        &self,
        user: &AuthenticatedUser,
        bookmark_id: &str,
    ) -> Result<bool, String> {
        let _file_lock = self.lock_files()?;
        let path = self.bookmarks_path(&user.user_id)?;
        let bookmarks = load_bookmarks_from_path(&path)?;
        let original_len = bookmarks.len();
        let filtered: Vec<Bookmark> = bookmarks
            .into_iter()
            .filter(|bookmark| bookmark.id != bookmark_id)
            .collect();
        if filtered.len() == original_len {
            return Ok(false);
        }
        write_json_file(&path, &filtered)?;
        Ok(true)
    }

    pub fn list_notes(&self, user: &AuthenticatedUser) -> Result<Vec<Note>, String> {
        let _file_lock = self.lock_files()?;
        let path = self.notes_path(&user.user_id)?;
        let notes = load_notes_from_path(&path)?;
        if !path.try_exists().map_err(|error| error.to_string())? {
            write_json_file(&path, &notes)?;
        }
        Ok(notes)
    }

    pub fn create_note(
        &self,
        user: &AuthenticatedUser,
        title: String,
        content: String,
        category: String,
    ) -> Result<Note, String> {
        let _file_lock = self.lock_files()?;
        let path = self.notes_path(&user.user_id)?;
        let mut notes = load_notes_from_path(&path)?;
        let note = Note {
            id: Uuid::new_v4().to_string(),
            title,
            content,
            category,
            created_at: iso_timestamp(),
            updated_at: None,
        };
        notes.push(note.clone());
        write_json_file(&path, &notes)?;
        Ok(note)
    }

    pub fn update_note(
        &self,
        user: &AuthenticatedUser,
        note_id: &str,
        updates: NoteUpdate,
    ) -> Result<Option<Note>, String> {
        let _file_lock = self.lock_files()?;
        let path = self.notes_path(&user.user_id)?;
        let mut notes = load_notes_from_path(&path)?;
        let Some(note) = notes.iter_mut().find(|note| note.id == note_id) else {
            return Ok(None);
        };

        if let Some(title) = updates.title {
            note.title = title;
        }
        if let Some(content) = updates.content {
            note.content = content;
        }
        if let Some(category) = updates.category {
            note.category = category;
        }
        note.updated_at = Some(iso_timestamp());
        let updated = note.clone();
        write_json_file(&path, &notes)?;
        Ok(Some(updated))
    }

    pub fn delete_note(&self, user: &AuthenticatedUser, note_id: &str) -> Result<bool, String> {
        let _file_lock = self.lock_files()?;
        let path = self.notes_path(&user.user_id)?;
        let notes = load_notes_from_path(&path)?;
        let original_len = notes.len();
        let filtered: Vec<Note> = notes
            .into_iter()
            .filter(|note| note.id != note_id)
            .collect();
        if filtered.len() == original_len {
            return Ok(false);
        }
        write_json_file(&path, &filtered)?;
        Ok(true)
    }

    pub fn list_mobile_keyboard_debug_entries(
        &self,
        user: &AuthenticatedUser,
    ) -> Result<Vec<Value>, String> {
        let _file_lock = self.lock_files()?;
        let path = self.mobile_keyboard_debug_path(&user.user_id)?;
        if !path.exists() {
            write_json_file(&path, &Vec::<Value>::new())?;
            return Ok(Vec::new());
        }
        Ok(read_json_file::<Vec<Value>>(&path).unwrap_or_default())
    }

    pub fn append_mobile_keyboard_debug_entry(
        &self,
        user: &AuthenticatedUser,
        mut entry: Value,
        request_user_agent: Option<&str>,
    ) -> Result<Value, String> {
        let _file_lock = self.lock_files()?;
        let path = self.mobile_keyboard_debug_path(&user.user_id)?;
        let Value::Object(ref mut map) = entry else {
            return Err("Mobile keyboard debug payload must be a JSON object".to_string());
        };

        map.insert(
            "serverRecordedAt".to_string(),
            Value::String(iso_timestamp()),
        );
        if let Some(user_agent) = request_user_agent {
            map.insert(
                "requestUserAgent".to_string(),
                Value::String(user_agent.to_string()),
            );
        }

        let mut entries = if path.exists() {
            read_json_file::<Vec<Value>>(&path).unwrap_or_default()
        } else {
            Vec::new()
        };
        entries.push(entry.clone());
        if entries.len() > MOBILE_KEYBOARD_DEBUG_ENTRY_LIMIT {
            let overflow = entries.len() - MOBILE_KEYBOARD_DEBUG_ENTRY_LIMIT;
            entries.drain(0..overflow);
        }
        write_json_file(&path, &entries)?;
        Ok(entry)
    }

    pub fn clear_mobile_keyboard_debug_entries(
        &self,
        user: &AuthenticatedUser,
    ) -> Result<(), String> {
        let _file_lock = self.lock_files()?;
        let path = self.mobile_keyboard_debug_path(&user.user_id)?;
        write_json_file(&path, &Vec::<Value>::new())
    }

    // --- Vault ---

    pub fn list_vault_keys(
        &self,
        user: &AuthenticatedUser,
    ) -> Result<Vec<crate::vault::VaultEntry>, String> {
        let connection = self.lock_db()?;
        let mut stmt = connection
            .prepare("SELECT id, key_name, key_value, created_at FROM api_key_vault WHERE user_id = ? ORDER BY created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&user.user_id], |row| {
                Ok(crate::vault::VaultEntry {
                    id: row.get(0)?,
                    key_name: row.get(1)?,
                    key_value: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn add_vault_key(
        &self,
        user: &AuthenticatedUser,
        id: &str,
        key_name: &str,
        key_value: &str,
        created_at: &str,
    ) -> Result<(), String> {
        let connection = self.lock_db()?;
        connection
            .execute(
                "INSERT INTO api_key_vault (id, user_id, key_name, key_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, user.user_id, key_name, key_value, created_at],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_vault_key(
        &self,
        user: &AuthenticatedUser,
        key_id: &str,
    ) -> Result<Option<crate::vault::VaultEntry>, String> {
        let connection = self.lock_db()?;
        let mut stmt = connection
            .prepare("SELECT id, key_name, key_value, created_at FROM api_key_vault WHERE id = ? AND user_id = ?")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_row(rusqlite::params![key_id, user.user_id], |row| {
                Ok(crate::vault::VaultEntry {
                    id: row.get(0)?,
                    key_name: row.get(1)?,
                    key_value: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .ok();
        Ok(result)
    }

    pub fn migrate_vault_key(
        &self,
        user: &AuthenticatedUser,
        key_id: &str,
        original: &str,
        encrypted: &str,
    ) -> Result<(), String> {
        self.lock_db()?.execute(
            "UPDATE api_key_vault SET key_value = ?1 WHERE id = ?2 AND user_id = ?3 AND key_value = ?4",
            params![encrypted, key_id, user.user_id, original],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_vault_key(&self, user: &AuthenticatedUser, key_id: &str) -> Result<bool, String> {
        let connection = self.lock_db()?;
        let count = connection
            .execute(
                "DELETE FROM api_key_vault WHERE id = ? AND user_id = ?",
                rusqlite::params![key_id, user.user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn list_terminal_sessions(
        &self,
        user: &AuthenticatedUser,
    ) -> Result<Vec<TerminalSessionSummary>, String> {
        let sessions_dir = self.user_data_dir(&user.user_id)?.join("sessions");
        if !sessions_dir.exists() {
            return Ok(Vec::new());
        }

        let mut sessions = Vec::new();
        for entry in fs::read_dir(&sessions_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("json")
            {
                continue;
            }

            let session = match read_json_file::<PersistedTerminalSession>(&path) {
                Ok(session) => session,
                Err(_) => continue,
            };
            let message_count = session
                .history
                .iter()
                .filter(|entry| !entry.text.is_empty())
                .count();
            let last_activity_at = session
                .thread
                .as_ref()
                .map(|thread| thread.last_activity_at.clone())
                .unwrap_or_else(|| session.updated_at.clone());

            sessions.push(TerminalSessionSummary {
                id: session.id,
                title: session.title,
                shell: session.shell,
                cwd: session.cwd,
                cwd_source: None,
                group_path: None,
                created_at: session.created_at,
                updated_at: session.updated_at,
                last_activity_at,
                message_count,
                is_active: false,
                is_busy: false,
                uses_tmux: false,
                sandbox: session.sandbox,
                thread: session.thread,
            });
        }

        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(sessions)
    }

    pub fn get_terminal_session_history(
        &self,
        user: &AuthenticatedUser,
        session_id: &str,
        query: &HistoryQuery,
    ) -> Result<Option<TerminalSessionSnapshot>, String> {
        let Some(mut session) = self.load_persisted_terminal_session(&user.user_id, session_id)?
        else {
            return Ok(None);
        };

        ensure_history_sequences(&mut session.history);
        let history = limit_history(&session.history, query);

        Ok(Some(TerminalSessionSnapshot {
            id: session.id,
            title: session.title,
            shell: session.shell,
            created_at: session.created_at,
            updated_at: session.updated_at,
            history,
            uses_tmux: false,
            current_cols: None,
            current_rows: None,
            sandbox: session.sandbox,
        }))
    }

    fn load_persisted_terminal_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Option<PersistedTerminalSession>, String> {
        let sessions_dir = self.user_data_dir(user_id)?.join("sessions");
        let path = sessions_dir.join(format!("{}.json", sanitize_id(session_id)?));
        if !path.exists() {
            return Ok(None);
        }

        read_json_file::<PersistedTerminalSession>(&path)
            .map(Some)
            .or(Ok(None))
    }

    fn initialize_schema(&self) -> Result<(), String> {
        let mut connection = self.lock_db()?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS auth_generations (
                    user_id TEXT PRIMARY KEY,
                    generation INTEGER NOT NULL CHECK(generation >= 0)
                );

                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id TEXT PRIMARY KEY,
                    groq_api_key TEXT,
                    preview_url TEXT,
                    terminal_font_size INTEGER DEFAULT NULL,
                    sidebar_collapsed INTEGER DEFAULT 0,
                    terminal_webgl_enabled INTEGER DEFAULT NULL,
                    theme TEXT DEFAULT 'dark',
                    tab_order TEXT,
                    sandbox_default_mode TEXT DEFAULT 'off',
                    desktop_allow_terminal_input INTEGER DEFAULT 0,
                    recent_folders TEXT,
                    pinned_folders TEXT,
                    sidebar_projects TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);

                CREATE TABLE IF NOT EXISTS passkey_credentials (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    credential_id TEXT NOT NULL UNIQUE,
                    public_key BLOB NOT NULL,
                    counter INTEGER NOT NULL DEFAULT 0,
                    device_type TEXT NOT NULL DEFAULT 'singleDevice',
                    backed_up INTEGER NOT NULL DEFAULT 0,
                    transports TEXT,
                    name TEXT,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);
                CREATE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id ON passkey_credentials(credential_id);

                CREATE TABLE IF NOT EXISTS api_key_vault (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    key_name TEXT NOT NULL,
                    key_value TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(user_id, key_name)
                );
                ",
            )
            .map_err(|error| error.to_string())?;
        let columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(user_settings)")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        for (name, definition) in [
            ("groq_api_key", "TEXT"),
            ("preview_url", "TEXT"),
            ("terminal_font_size", "INTEGER DEFAULT NULL"),
            ("sidebar_collapsed", "INTEGER DEFAULT 0"),
            ("terminal_webgl_enabled", "INTEGER DEFAULT NULL"),
            ("theme", "TEXT DEFAULT 'dark'"),
            ("tab_order", "TEXT"),
            ("sandbox_default_mode", "TEXT DEFAULT 'off'"),
            ("desktop_allow_terminal_input", "INTEGER DEFAULT 0"),
            ("recent_folders", "TEXT"),
            ("pinned_folders", "TEXT"),
            ("sidebar_projects", "TEXT"),
        ] {
            if !columns
                .iter()
                .any(|column| column.eq_ignore_ascii_case(name))
            {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE user_settings ADD COLUMN {name} {definition};"
                    ))
                    .map_err(|error| format!("Failed to migrate user_settings.{name}: {error}"))?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    fn ensure_user_row(&self, user: &AuthenticatedUser) -> Result<(), String> {
        if self.get_user_by_id(&user.user_id)?.is_some() {
            Ok(())
        } else {
            self.upsert_external_auth_mirror_user(&user.user_id)
        }
    }

    fn upsert_external_auth_mirror_user(&self, user_id: &str) -> Result<(), String> {
        let existing = self.get_user_by_id(user_id)?;
        let connection = self.lock_db()?;
        let now = iso_timestamp();
        let (created_at, stored_username) = match existing.as_ref() {
            Some(user) if is_external_auth_mirror_user(user) => {
                (user.created_at.clone(), user.username.clone())
            }
            Some(user) => (
                user.created_at.clone(),
                external_auth_mirror_username(user_id),
            ),
            None => (now.clone(), external_auth_mirror_username(user_id)),
        };
        connection
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     username = excluded.username,
                     updated_at = excluded.updated_at",
                params![
                    user_id,
                    stored_username,
                    EXTERNAL_AUTH_MIRROR_PASSWORD_HASH,
                    created_at,
                    now
                ],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn user_data_dir(&self, user_id: &str) -> Result<PathBuf, String> {
        let sanitized = sanitize_id(user_id)?;
        let path = self.inner.config.data_dir.join("users").join(sanitized);
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(path)
    }

    fn bookmarks_path(&self, user_id: &str) -> Result<PathBuf, String> {
        Ok(self.user_data_dir(user_id)?.join("bookmarks.json"))
    }

    fn notes_path(&self, user_id: &str) -> Result<PathBuf, String> {
        Ok(self.user_data_dir(user_id)?.join("notes.json"))
    }

    fn mobile_keyboard_debug_path(&self, user_id: &str) -> Result<PathBuf, String> {
        Ok(self
            .user_data_dir(user_id)?
            .join("mobile-keyboard-debug.json"))
    }

    fn issue_auth_result(&self, user: &StoredUser) -> Result<AuthResult, String> {
        self.issue_auth_result_for_public_user(to_public_user(user))
    }

    pub(crate) fn issue_auth_result_for_public_user(
        &self,
        user: UserPublic,
    ) -> Result<AuthResult, String> {
        crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &user.username,
        )?;
        let mut connection = self.lock_db()?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let refresh_token = Self::insert_refresh_token(&transaction, &user.id)?;
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let result = self.auth_result_for_user(user, refresh_token, generation);
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(result)
    }

    fn auth_result_for_user(
        &self,
        user: UserPublic,
        refresh_token: String,
        generation: i64,
    ) -> AuthResult {
        AuthResult {
            user: user.clone(),
            tokens: TokenPair {
                access_token: issue_access_token_for_generation(
                    &self.inner.config.jwt_secret,
                    &user.id,
                    &user.username,
                    generation,
                ),
                refresh_token,
            },
        }
    }

    fn rotate_refresh_token(
        &self,
        stored_token: &StoredRefreshToken,
        user: UserPublic,
    ) -> Result<Option<AuthResult>, String> {
        if crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &user.username,
        )
        .is_err()
        {
            return Ok(None);
        }
        let mut connection = self.lock_db()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let consumed = transaction
            .execute(
                "DELETE FROM refresh_tokens WHERE id = ? AND user_id = ? AND expires_at >= ?",
                params![stored_token.id, user.id, iso_timestamp()],
            )
            .map_err(|error| error.to_string())?;
        if consumed == 0 {
            return Ok(None);
        }
        let refresh_token = Self::insert_refresh_token(&transaction, &user.id)?;
        let generation = Self::auth_generation(&transaction, &user.id)?;
        let result = self.auth_result_for_user(user, refresh_token, generation);
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(Some(result))
    }

    async fn login_external(
        &self,
        identifier: &str,
        password: &str,
    ) -> Result<Option<AuthResult>, String> {
        let Some(provider) = self.inner.external_auth.clone() else {
            return Ok(None);
        };
        let Some(user) = provider.get_user_by_identifier(identifier).await? else {
            return Ok(None);
        };
        let is_valid = verify(password, &user.password_hash).map_err(|error| error.to_string())?;
        if !is_valid {
            return Ok(None);
        }
        if crate::auth::validate_allowed_username(
            self.config().allowed_username.as_deref(),
            &user.resolved_username(),
        )
        .is_err()
        {
            return Ok(None);
        }
        self.upsert_external_auth_mirror_user(&user.id)?;
        self.issue_auth_result_for_external_user(user).map(Some)
    }

    async fn refresh_external(
        &self,
        stored_token: StoredRefreshToken,
    ) -> Result<Option<AuthResult>, String> {
        let Some(provider) = self.inner.external_auth.clone() else {
            self.delete_refresh_token(&stored_token.id)?;
            return Ok(None);
        };
        let Some(user) = provider.get_user_by_id(&stored_token.user_id).await? else {
            self.delete_refresh_token(&stored_token.id)?;
            return Ok(None);
        };
        self.upsert_external_auth_mirror_user(&user.id)?;
        let username = user.resolved_username();
        self.rotate_refresh_token(
            &stored_token,
            UserPublic {
                id: user.id,
                username,
                created_at: user.created_at,
            },
        )
    }

    fn issue_auth_result_for_external_user(
        &self,
        user: ExternalAuthUser,
    ) -> Result<AuthResult, String> {
        let username = user.resolved_username();
        self.issue_auth_result_for_public_user(UserPublic {
            id: user.id,
            username,
            created_at: user.created_at,
        })
    }

    pub(crate) async fn get_passkey_user_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<UserPublic>, String> {
        if let Some(user) = self.get_user_by_username(identifier)? {
            if !is_external_auth_mirror_user(&user) {
                return Ok(Some(to_public_user(&user)));
            }
        }
        let Some(provider) = self.inner.external_auth.clone() else {
            return Ok(None);
        };
        let Some(user) = provider.get_user_by_identifier(identifier).await? else {
            return Ok(None);
        };
        // Passkeys are owned by the local mirror's stable external user id.
        self.upsert_external_auth_mirror_user(&user.id)?;
        let username = user.resolved_username();
        Ok(Some(UserPublic {
            id: user.id,
            username,
            created_at: user.created_at,
        }))
    }

    pub(crate) fn get_user_public_by_id(
        &self,
        user_id: &str,
    ) -> Result<Option<UserPublic>, String> {
        self.get_user_by_id(user_id)
            .map(|value| value.map(|user| to_public_user(&user)))
    }

    fn insert_refresh_token(connection: &Connection, user_id: &str) -> Result<String, String> {
        let token = Uuid::new_v4().to_string();
        let token_hash = hash_token(&token);
        let expires_at = OffsetDateTime::now_utc() + time::Duration::days(REFRESH_TOKEN_TTL_DAYS);
        connection
            .execute(
                "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                params![
                    Uuid::new_v4().to_string(),
                    user_id,
                    token_hash,
                    expires_at
                        .format(&Rfc3339)
                        .expect("rfc3339 formatting should succeed"),
                    iso_timestamp()
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(token)
    }

    fn get_user_by_username(&self, username: &str) -> Result<Option<StoredUser>, String> {
        let connection = self.lock_db()?;
        connection
            .query_row(
                "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
                params![username],
                |row| {
                    Ok(StoredUser {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        password_hash: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn get_user_by_id(&self, user_id: &str) -> Result<Option<StoredUser>, String> {
        let connection = self.lock_db()?;
        connection
            .query_row(
                "SELECT id, username, password_hash, created_at FROM users WHERE id = ?",
                params![user_id],
                |row| {
                    Ok(StoredUser {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        password_hash: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn get_refresh_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<StoredRefreshToken>, String> {
        let connection = self.lock_db()?;
        connection
            .query_row(
                "SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?",
                params![token_hash],
                |row| {
                    Ok(StoredRefreshToken {
                        id: row.get(0)?,
                        user_id: row.get(1)?,
                        expires_at: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    fn delete_refresh_token(&self, token_id: &str) -> Result<(), String> {
        let connection = self.lock_db()?;
        connection
            .execute("DELETE FROM refresh_tokens WHERE id = ?", params![token_id])
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn delete_expired_refresh_tokens(&self) -> Result<(), String> {
        let connection = self.lock_db()?;
        connection
            .execute(
                "DELETE FROM refresh_tokens WHERE expires_at < ?",
                params![iso_timestamp()],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn lock_db(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.inner
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())
    }

    fn lock_files(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.inner
            .file_lock
            .lock()
            .map_err(|_| "File lock poisoned".to_string())
    }
}

impl SettingsPatch {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let Value::Object(map) = value else {
            return Err("Settings payload must be a JSON object".to_string());
        };

        let groq_api_key = read_nullable_string(&map, "groqApiKey")?;
        if let FieldPatch::Value(key) = &groq_api_key {
            if !key.is_empty() && !key.starts_with("gsk_") {
                return Err("Invalid Groq API key format (should start with gsk_)".to_string());
            }
            if !key.is_empty() && key.len() < 20 {
                return Err("Groq API key is too short".to_string());
            }
        }

        let terminal_font_size = read_nullable_i64(&map, "terminalFontSize")?;
        if let FieldPatch::Value(size) = terminal_font_size {
            if !(8..=32).contains(&size) {
                return Err("Terminal font size must be between 8 and 32".to_string());
            }
        }

        let theme = read_nullable_string(&map, "theme")?;
        if let FieldPatch::Value(theme_value) = &theme {
            if theme_value != "dark" && theme_value != "light" {
                return Err("Theme must be \"dark\" or \"light\"".to_string());
            }
        }

        let sandbox_default_mode = read_nullable_string(&map, "sandboxDefaultMode")?;
        if let FieldPatch::Value(mode) = &sandbox_default_mode {
            if !SANDBOX_MODES.contains(&mode.as_str()) {
                return Err(format!(
                    "Sandbox mode must be one of: {}",
                    SANDBOX_MODES.join(", ")
                ));
            }
            if mode != "off" {
                return Err(
                    "Sandbox modes are disabled until runtime isolation is enforced".to_string(),
                );
            }
        }

        Ok(Self {
            groq_api_key,
            preview_url: read_nullable_string(&map, "previewUrl")?,
            terminal_font_size,
            sidebar_collapsed: read_nullable_bool(&map, "sidebarCollapsed")?,
            terminal_webgl_enabled: read_nullable_bool(&map, "terminalWebglEnabled")?,
            desktop_allow_terminal_input: read_nullable_bool(&map, "desktopAllowTerminalInput")?,
            theme,
            tab_order: read_nullable_string_array(&map, "tabOrder")?,
            sandbox_default_mode,
            recent_folders: read_nullable_string_array(&map, "recentFolders")?,
            pinned_folders: read_nullable_string_array(&map, "pinnedFolders")?,
            sidebar_projects: read_nullable_sidebar_projects(&map, "sidebarProjects")?,
        })
    }
}

fn update_text_patch(
    transaction: &Transaction<'_>,
    user_id: &str,
    field: &str,
    patch: &FieldPatch<String>,
) -> Result<(), String> {
    match patch {
        FieldPatch::Missing => Ok(()),
        FieldPatch::Null => execute_update(transaction, field, rusqlite::types::Null, user_id),
        FieldPatch::Value(value) => {
            let value = if value.is_empty() {
                None
            } else {
                Some(value.as_str())
            };
            execute_update(transaction, field, value, user_id)
        }
    }
}

fn update_i64_patch(
    transaction: &Transaction<'_>,
    user_id: &str,
    field: &str,
    patch: &FieldPatch<i64>,
) -> Result<(), String> {
    match patch {
        FieldPatch::Missing => Ok(()),
        FieldPatch::Null => execute_update(transaction, field, rusqlite::types::Null, user_id),
        FieldPatch::Value(value) => execute_update(transaction, field, value, user_id),
    }
}

fn update_bool_patch(
    transaction: &Transaction<'_>,
    user_id: &str,
    field: &str,
    patch: &FieldPatch<bool>,
) -> Result<(), String> {
    match patch {
        FieldPatch::Missing => Ok(()),
        FieldPatch::Null => execute_update(transaction, field, rusqlite::types::Null, user_id),
        FieldPatch::Value(value) => execute_update(
            transaction,
            field,
            if *value { 1_i64 } else { 0_i64 },
            user_id,
        ),
    }
}

fn update_json_patch<T: serde::Serialize>(
    transaction: &Transaction<'_>,
    user_id: &str,
    field: &str,
    patch: &FieldPatch<T>,
) -> Result<(), String> {
    match patch {
        FieldPatch::Missing => Ok(()),
        FieldPatch::Null => execute_update(transaction, field, rusqlite::types::Null, user_id),
        FieldPatch::Value(value) => execute_update(
            transaction,
            field,
            serde_json::to_string(value).map_err(|error| error.to_string())?,
            user_id,
        ),
    }
}

fn execute_update<T: rusqlite::ToSql>(
    transaction: &Transaction<'_>,
    field: &str,
    value: T,
    user_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            &format!("UPDATE user_settings SET {field} = ? WHERE user_id = ?"),
            params![value, user_id],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn deserialize_array<T: serde::de::DeserializeOwned>(
    value: Option<String>,
) -> Result<Option<Vec<T>>, String> {
    match value {
        Some(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

fn normalize_sandbox_mode(value: Option<String>) -> String {
    let value = value.unwrap_or_else(|| "off".to_string());
    if value == "off" {
        value
    } else {
        "off".to_string()
    }
}

fn sanitize_id(value: &str) -> Result<String, String> {
    let sanitized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect();
    if sanitized.is_empty() {
        return Err("User id must contain alphanumeric characters or hyphens".to_string());
    }
    Ok(sanitized)
}

fn mask_api_key(value: &str) -> String {
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let masked_len = value.chars().count().saturating_sub(4);
    format!("{}{}", "*".repeat(masked_len), suffix)
}

fn default_bookmark() -> Bookmark {
    Bookmark {
        id: Uuid::new_v4().to_string(),
        name: "Claude Code (skip permissions)".to_string(),
        command: "claude --dangerously-skip-permissions".to_string(),
        category: "Claude".to_string(),
        created_at: iso_timestamp(),
        updated_at: None,
    }
}

fn to_public_user(user: &StoredUser) -> UserPublic {
    let username = if user.password_hash == crate::local_testing::PASSWORD_MARKER
        && user.id.starts_with(crate::local_testing::ACCOUNT_PREFIX)
    {
        user.username
            .strip_prefix(crate::local_testing::USERNAME_PREFIX)
            .unwrap_or(&user.username)
    } else {
        &user.username
    };
    UserPublic {
        id: user.id.clone(),
        username: username.to_owned(),
        created_at: user.created_at.clone(),
    }
}

fn load_bookmarks_from_path(path: &Path) -> Result<Vec<Bookmark>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![default_bookmark()]),
        Err(error) => Err(error.to_string()),
    }
}

fn load_notes_from_path(path: &Path) -> Result<Vec<Note>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    let contents = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Missing data directory")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(&contents)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn iso_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("rfc3339 formatting should succeed")
}

fn hash_token(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn limit_history(
    history: &[TerminalStreamEvent],
    query: &HistoryQuery,
) -> Vec<TerminalStreamEvent> {
    if query.max_history_chars.is_none()
        && query.max_history_events.is_none()
        && query.before_ts.is_none()
        && query.after_ts.is_none()
        && query.before_seq.is_none()
        && query.after_seq.is_none()
    {
        return history.to_vec();
    }

    let end_index = query
        .before_seq
        .map(|before_seq| find_history_end_index_by_seq(history, before_seq))
        .or_else(|| {
            query
                .before_ts
                .map(|before_ts| find_history_end_index(history, before_ts))
        })
        .unwrap_or(history.len());
    let mut start_index = query
        .after_seq
        .map(|after_seq| find_history_start_index_by_seq(history, after_seq))
        .or_else(|| {
            query
                .after_ts
                .map(|after_ts| find_history_start_index(history, after_ts))
        })
        .unwrap_or(0);

    if start_index > end_index {
        start_index = end_index;
    }

    if let Some(max_history_events) = query.max_history_events {
        if end_index.saturating_sub(start_index) > max_history_events {
            start_index = end_index.saturating_sub(max_history_events);
        }
    }

    if let Some(max_history_chars) = query.max_history_chars {
        let mut char_count = 0_usize;
        for index in (start_index..end_index).rev() {
            char_count += history[index].text.len();
            if char_count > max_history_chars {
                start_index = index + 1;
                break;
            }
        }
    }

    history[start_index..end_index].to_vec()
}

fn ensure_history_sequences(history: &mut [TerminalStreamEvent]) -> i64 {
    let mut next_seq = 1_i64;
    for entry in history.iter_mut() {
        if entry.seq.is_none() {
            entry.seq = Some(next_seq);
        }
        next_seq = next_seq.max(entry.seq.unwrap_or(next_seq) + 1);
    }
    next_seq
}

fn find_history_end_index(history: &[TerminalStreamEvent], before_ts: i64) -> usize {
    if before_ts <= 0 {
        return history.len();
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].ts >= before_ts {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_start_index(history: &[TerminalStreamEvent], after_ts: i64) -> usize {
    if after_ts < 0 {
        return 0;
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].ts > after_ts {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_end_index_by_seq(history: &[TerminalStreamEvent], before_seq: i64) -> usize {
    if before_seq <= 0 {
        return history.len();
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].seq.unwrap_or(0) >= before_seq {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn find_history_start_index_by_seq(history: &[TerminalStreamEvent], after_seq: i64) -> usize {
    if after_seq < 0 {
        return 0;
    }

    let mut low = 0_usize;
    let mut high = history.len();
    while low < high {
        let mid = (low + high) / 2;
        if history[mid].seq.unwrap_or(0) > after_seq {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn external_auth_mirror_username(user_id: &str) -> String {
    format!("external-{user_id}")
}

fn is_external_auth_mirror_user(user: &StoredUser) -> bool {
    user.password_hash == EXTERNAL_AUTH_MIRROR_PASSWORD_HASH
}

fn read_nullable_string(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<FieldPatch<String>, String> {
    match map.get(key) {
        Some(Value::String(value)) => Ok(FieldPatch::Value(value.clone())),
        Some(Value::Null) => Ok(FieldPatch::Null),
        Some(_) => Err(format!("{key} must be a string or null")),
        None => Ok(FieldPatch::Missing),
    }
}

fn read_nullable_i64(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<FieldPatch<i64>, String> {
    match map.get(key) {
        Some(Value::Number(value)) => value
            .as_i64()
            .map(FieldPatch::Value)
            .ok_or_else(|| format!("{key} must be an integer")),
        Some(Value::Null) => Ok(FieldPatch::Null),
        Some(_) => Err(format!("{key} must be a number or null")),
        None => Ok(FieldPatch::Missing),
    }
}

fn read_nullable_bool(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<FieldPatch<bool>, String> {
    match map.get(key) {
        Some(Value::Bool(value)) => Ok(FieldPatch::Value(*value)),
        Some(Value::Null) => Ok(FieldPatch::Null),
        Some(_) => Err(format!("{key} must be a boolean or null")),
        None => Ok(FieldPatch::Missing),
    }
}

fn read_nullable_string_array(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<FieldPatch<Vec<String>>, String> {
    match map.get(key) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => Err(format!("{key} entries must be strings")),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(FieldPatch::Value),
        Some(Value::Null) => Ok(FieldPatch::Null),
        Some(_) => Err(format!("{key} must be an array of strings or null")),
        None => Ok(FieldPatch::Missing),
    }
}

fn read_nullable_sidebar_projects(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<FieldPatch<Vec<SidebarProject>>, String> {
    match map.get(key) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                let Value::Object(object) = value else {
                    return Err(format!("{key} entries must be objects"));
                };
                let Some(Value::String(path)) = object.get("path") else {
                    return Err(format!("{key} entries must include a string path"));
                };
                let Some(Value::String(name)) = object.get("name") else {
                    return Err(format!("{key} entries must include a string name"));
                };
                Ok(SidebarProject {
                    path: path.clone(),
                    name: name.clone(),
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(FieldPatch::Value),
        Some(Value::Null) => Ok(FieldPatch::Null),
        Some(_) => Err(format!("{key} must be an array of objects or null")),
        None => Ok(FieldPatch::Missing),
    }
}
