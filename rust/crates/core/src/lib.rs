use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

pub const DEFAULT_JWT_SECRET: &str = "dev-jwt-secret-change-in-production";
pub const SANDBOX_MODES: [&str; 3] = ["off", "read-only", "workspace-write"];
const DEFAULT_APP_DATA_DIR_NAME: &str = "terminal-v4";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub host: IpAddr,
    pub port: u16,
    pub data_dir: PathBuf,
    pub jwt_secret: String,
    pub allowed_username: Option<String>,
    pub storage_database_url: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let default = Self::default();
        let host = env::var("HOST")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default.host);
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default.port);
        let data_dir = env::var("TERMINAL_DATA_DIR")
            .or_else(|_| env::var("DATA_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| default.data_dir.clone());
        let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| default.jwt_secret.clone());
        let allowed_username = env::var("ALLOWED_USERNAME")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let storage_database_url = env::var("STORAGE_DATABASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        Self {
            host,
            port,
            data_dir,
            jwt_secret,
            allowed_username,
            storage_database_url,
        }
    }

    pub fn bind_addr(&self) -> SocketAddr {
        SocketAddr::from((self.host, self.port))
    }

    pub fn validate_runtime(&self) -> Result<(), String> {
        if !self.host.is_loopback() && self.jwt_secret == DEFAULT_JWT_SECRET {
            return Err(
                "Refusing to start with the default JWT secret on a non-loopback host. Set JWT_SECRET to a strong random value."
                    .to_string(),
            );
        }

        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 3020,
            data_dir: default_data_dir(),
            jwt_secret: DEFAULT_JWT_SECRET.to_string(),
            allowed_username: None,
            storage_database_url: None,
        }
    }
}

fn default_data_dir() -> PathBuf {
    platform_data_root()
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join(DEFAULT_APP_DATA_DIR_NAME)
}

#[cfg(target_os = "windows")]
fn platform_data_root() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn platform_data_root() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn platform_data_root() -> Option<PathBuf> {
    env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local").join("share"))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: String,
}

impl HealthResponse {
    pub fn ok() -> Self {
        Self {
            status: "ok".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthMeResponse {
    pub id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserPublic {
    pub id: String,
    pub username: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthResult {
    pub user: UserPublic,
    pub tokens: TokenPair,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidebarProject {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub groq_api_key: Option<String>,
    pub has_groq_api_key: bool,
    pub preview_url: Option<String>,
    pub terminal_font_size: Option<i64>,
    pub sidebar_collapsed: bool,
    pub terminal_webgl_enabled: Option<bool>,
    pub desktop_allow_terminal_input: Option<bool>,
    pub theme: String,
    pub tab_order: Option<Vec<String>>,
    pub sandbox_default_mode: String,
    pub recent_folders: Option<Vec<String>>,
    pub pinned_folders: Option<Vec<String>>,
    pub sidebar_projects: Option<Vec<SidebarProject>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub command: String,
    pub category: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGitStats {
    pub lines_added: i64,
    pub lines_removed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub topic: Option<String>,
    pub topic_auto_generated: bool,
    pub pinned: bool,
    pub archived: bool,
    pub project_path: Option<String>,
    pub sandbox_mode: String,
    pub sandbox_workspace_root: Option<String>,
    pub git_stats: Option<ThreadGitStats>,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSandboxInfo {
    pub mode: String,
    pub workspace_root: Option<String>,
    pub runtime_id: Option<String>,
    pub runtime_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub id: String,
    pub title: String,
    pub shell: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: String,
    pub message_count: usize,
    pub is_active: bool,
    pub is_busy: bool,
    pub uses_tmux: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<TerminalSandboxInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalStreamEvent {
    pub text: String,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub id: String,
    pub title: String,
    pub shell: String,
    pub created_at: String,
    pub updated_at: String,
    pub history: Vec<TerminalStreamEvent>,
    pub uses_tmux: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_cols: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_rows: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<TerminalSandboxInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StructuredSessionEvent {
    SessionStarted {
        ts: i64,
        seq: i64,
        #[serde(rename = "sessionId")]
        session_id: String,
        provider: String,
    },
    SessionEnded {
        ts: i64,
        seq: i64,
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
    },
    MessageStarted {
        ts: i64,
        seq: i64,
        role: String,
    },
    MessageDelta {
        ts: i64,
        seq: i64,
        role: String,
        content: String,
    },
    MessageCompleted {
        ts: i64,
        seq: i64,
        role: String,
        content: String,
    },
    ToolStarted {
        ts: i64,
        seq: i64,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: Value,
        #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },
    ToolOutput {
        ts: i64,
        seq: i64,
        #[serde(rename = "toolName")]
        tool_name: String,
        output: String,
        #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },
    ToolCompleted {
        ts: i64,
        seq: i64,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: String,
        #[serde(rename = "isError")]
        is_error: bool,
        #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },
    ApprovalRequired {
        ts: i64,
        seq: i64,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: Value,
        description: String,
    },
    InputRequired {
        ts: i64,
        seq: i64,
        prompt: String,
    },
    Status {
        ts: i64,
        seq: i64,
        status: String,
    },
    Error {
        ts: i64,
        seq: i64,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    RawProviderEvent {
        ts: i64,
        seq: i64,
        provider: String,
        data: Value,
    },
}

impl StructuredSessionEvent {
    /// Return the sequence number common to every event variant.
    pub fn seq(&self) -> i64 {
        match self {
            Self::SessionStarted { seq, .. }
            | Self::SessionEnded { seq, .. }
            | Self::MessageStarted { seq, .. }
            | Self::MessageDelta { seq, .. }
            | Self::MessageCompleted { seq, .. }
            | Self::ToolStarted { seq, .. }
            | Self::ToolOutput { seq, .. }
            | Self::ToolCompleted { seq, .. }
            | Self::ApprovalRequired { seq, .. }
            | Self::InputRequired { seq, .. }
            | Self::Status { seq, .. }
            | Self::Error { seq, .. }
            | Self::RawProviderEvent { seq, .. } => *seq,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_loopback_host() {
        assert_eq!(AppConfig::default().host, IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn default_data_dir_uses_app_specific_directory_name() {
        assert!(AppConfig::default()
            .data_dir
            .ends_with(DEFAULT_APP_DATA_DIR_NAME));
    }

    #[test]
    fn validate_runtime_rejects_default_secret_for_non_loopback_hosts() {
        let config = AppConfig {
            host: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            ..AppConfig::default()
        };

        assert!(config.validate_runtime().is_err());
    }

    #[test]
    fn validate_runtime_allows_default_secret_on_loopback() {
        assert!(AppConfig::default().validate_runtime().is_ok());
    }

    #[test]
    fn validate_runtime_allows_custom_secret_for_non_loopback_hosts() {
        let config = AppConfig {
            host: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            jwt_secret: "custom-secret".to_string(),
            ..AppConfig::default()
        };

        assert!(config.validate_runtime().is_ok());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredThreadMetadata {
    pub topic: Option<String>,
    pub topic_auto_generated: bool,
    pub pinned: bool,
    pub archived: bool,
    pub project_path: Option<String>,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredSessionSnapshot {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub cwd: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<StructuredThreadMetadata>,
    pub events: Vec<StructuredSessionEvent>,
}
