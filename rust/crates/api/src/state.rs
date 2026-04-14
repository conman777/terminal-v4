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

use crate::auth::{issue_access_token, AuthenticatedUser};
use crate::external_auth::{ExternalAuthProvider, ExternalAuthUser, PostgresExternalAuthProvider};
use crate::structured::StructuredSessionManager;
use crate::terminal::TerminalManager;

const EXTERNAL_AUTH_MIRROR_PASSWORD_HASH: &str = "!external-auth-mirror!";
const REFRESH_TOKEN_TTL_DAYS: i64 = 30;
const MOBILE_KEYBOARD_DEBUG_ENTRY_LIMIT: usize = 200;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    config: AppConfig,
    db: Mutex<Connection>,
    file_lock: Mutex<()>,
    external_auth: Option<Arc<dyn ExternalAuthProvider>>,
    terminal_manager: TerminalManager,
    structured_session_manager: StructuredSessionManager,
    process_manager: crate::processes::ProcessManager,
    stats_collector: Arc<crate::system_stats::SystemStatsCollector>,
    passkey_service: crate::passkey::PasskeyService,
    cookie_store: crate::preview::cookie_jar::CookieStore,
    port_scanner: crate::preview::port_scan::PortScanner,
    preview_log_store: crate::preview::logs::PreviewLogStore,
    preview_performance_store: crate::preview::performance::PerformanceStore,
    request_log_store: crate::preview::request_logs::RequestLogStore,
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
        let connection = Connection::open(config.data_dir.join("terminal.db"))
            .map_err(|error| error.to_string())?;
        let passkey_service = crate::passkey::PasskeyService::new(&config)?;

        let state = Self {
            inner: Arc::new(AppStateInner {
                terminal_manager: TerminalManager::new(config.clone()),
                structured_session_manager,
                process_manager: crate::processes::ProcessManager::new(),
                stats_collector: Arc::new(crate::system_stats::SystemStatsCollector::new()),
                passkey_service,
                cookie_store: crate::preview::cookie_jar::CookieStore::new(),
                port_scanner: crate::preview::port_scan::PortScanner::new(),
                preview_log_store: crate::preview::logs::PreviewLogStore::new(),
                preview_performance_store: crate::preview::performance::PerformanceStore::new(),
                request_log_store: crate::preview::request_logs::RequestLogStore::new(),
                config,
                db: Mutex::new(connection),
                file_lock: Mutex::new(()),
                external_auth,
            }),
        };
        state.initialize_schema()?;
        Ok(state)
    }

    pub fn config(&self) -> &AppConfig {
        &self.inner.config
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

        let is_valid = verify(password, &user.password_hash).map_err(|error| error.to_string())?;
        if !is_valid {
            return Ok(None);
        }

        self.issue_auth_result(&user).map(Some)
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

        let result = self.issue_auth_result(&user)?;
        self.delete_refresh_token(&stored_token.id)?;
        Ok(Some(result))
    }

    pub fn logout_user(&self, user_id: &str) -> Result<(), String> {
        let connection = self.lock_db()?;
        connection
            .execute(
                "DELETE FROM refresh_tokens WHERE user_id = ?",
                params![user_id],
            )
            .map(|_| ())
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
        let mut bookmarks = if path.exists() {
            read_json_file::<Vec<Bookmark>>(&path).unwrap_or_default()
        } else {
            Vec::new()
        };

        if !bookmarks
            .iter()
            .any(|bookmark| bookmark.command == "claude --dangerously-skip-permissions")
        {
            bookmarks.push(default_bookmark());
            write_json_file(&path, &bookmarks)?;
        } else if !path.exists() {
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
        let mut bookmarks = if path.exists() {
            read_json_file::<Vec<Bookmark>>(&path).unwrap_or_default()
        } else {
            vec![default_bookmark()]
        };

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
        let mut bookmarks = load_bookmarks_from_path(&path);
        if !bookmarks
            .iter()
            .any(|bookmark| bookmark.command == "claude --dangerously-skip-permissions")
        {
            bookmarks.push(default_bookmark());
        }
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
        let mut bookmarks = load_bookmarks_from_path(&path);
        if !bookmarks
            .iter()
            .any(|bookmark| bookmark.command == "claude --dangerously-skip-permissions")
        {
            bookmarks.push(default_bookmark());
        }
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
        if !path.exists() {
            write_json_file(&path, &Vec::<Note>::new())?;
            return Ok(Vec::new());
        }
        Ok(read_json_file::<Vec<Note>>(&path).unwrap_or_default())
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
        let mut notes = load_notes_from_path(&path);
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
        let mut notes = load_notes_from_path(&path);
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
        let notes = load_notes_from_path(&path);
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
        let connection = self.lock_db()?;
        connection
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
            .map_err(|error| error.to_string())
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
        let refresh_token = self.create_refresh_token(&user.id)?;
        Ok(AuthResult {
            user: user.clone(),
            tokens: TokenPair {
                access_token: issue_access_token(
                    &self.inner.config.jwt_secret,
                    &user.id,
                    &user.username,
                ),
                refresh_token,
            },
        })
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
        let result = self.issue_auth_result_for_external_user(user)?;
        self.delete_refresh_token(&stored_token.id)?;
        Ok(Some(result))
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

    pub(crate) fn get_user_public_by_username(
        &self,
        username: &str,
    ) -> Result<Option<UserPublic>, String> {
        self.get_user_by_username(username)
            .map(|value| value.map(|user| to_public_user(&user)))
    }

    pub(crate) fn get_user_public_by_id(
        &self,
        user_id: &str,
    ) -> Result<Option<UserPublic>, String> {
        self.get_user_by_id(user_id)
            .map(|value| value.map(|user| to_public_user(&user)))
    }

    fn create_refresh_token(&self, user_id: &str) -> Result<String, String> {
        let token = Uuid::new_v4().to_string();
        let token_hash = hash_token(&token);
        let expires_at = OffsetDateTime::now_utc() + time::Duration::days(REFRESH_TOKEN_TTL_DAYS);
        let connection = self.lock_db()?;
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
    if SANDBOX_MODES.contains(&value.as_str()) {
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
    UserPublic {
        id: user.id.clone(),
        username: user.username.clone(),
        created_at: user.created_at.clone(),
    }
}

fn load_bookmarks_from_path(path: &Path) -> Vec<Bookmark> {
    read_json_file::<Vec<Bookmark>>(path).unwrap_or_default()
}

fn load_notes_from_path(path: &Path) -> Vec<Note> {
    read_json_file::<Vec<Note>>(path).unwrap_or_default()
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
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
