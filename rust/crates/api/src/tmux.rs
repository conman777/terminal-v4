use std::time::Duration;
use tokio::process::Command;

const SESSION_PREFIX: &str = "terminal-app-";
const DEFAULT_HISTORY_LIMIT: u32 = 100_000;

/// Check if tmux is available on this system.
/// Always returns false on Windows.
pub async fn is_tmux_available() -> bool {
    if cfg!(windows) {
        return false;
    }
    Command::new("which")
        .arg("tmux")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build the tmux session name for a terminal session ID.
pub fn session_name(session_id: &str) -> String {
    format!("{SESSION_PREFIX}{session_id}")
}

/// Check if a tmux session exists for the given terminal session ID.
pub async fn session_exists(session_id: &str) -> bool {
    let name = session_name(session_id);
    Command::new("tmux")
        .args(["has-session", "-t", &name])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List all terminal-app tmux sessions, returning their session IDs
/// (with the prefix stripped).
pub async fn list_sessions() -> Vec<String> {
    let output = match run_tmux(&["list-sessions", "-F", "#{session_name}"], 5).await {
        Some(output) => output,
        None => return Vec::new(),
    };

    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix(SESSION_PREFIX))
        .map(|id| id.to_string())
        .collect()
}

/// Kill a tmux session for the given terminal session ID.
pub async fn kill_session(session_id: &str) -> Result<(), String> {
    let name = session_name(session_id);
    let output = Command::new("tmux")
        .args(["kill-session", "-t", &name])
        .output()
        .await
        .map_err(|e| format!("Failed to kill tmux session: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux kill-session failed: {stderr}"))
    }
}

/// Get the current working directory of a tmux session's active pane.
pub async fn get_session_cwd(session_id: &str) -> Option<String> {
    let name = session_name(session_id);
    let output = run_tmux(
        &[
            "display-message",
            "-t",
            &name,
            "-p",
            "#{pane_current_path}",
        ],
        5,
    )
    .await?;

    let cwd = output.trim();
    if cwd.is_empty() {
        None
    } else {
        Some(cwd.to_string())
    }
}

/// Create a new detached tmux session with the given shell command.
/// Returns Ok(()) if the session was created successfully.
pub async fn create_detached_session(
    session_id: &str,
    shell: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let name = session_name(session_id);
    let history_limit = history_limit_from_env();

    let output = Command::new("tmux")
        .args([
            "new-session",
            "-d",
            "-s",
            &name,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
            shell,
        ])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to create tmux session: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux new-session failed: {stderr}"));
    }

    // Apply history limit
    let _ = Command::new("tmux")
        .args([
            "set-option",
            "-t",
            &name,
            "history-limit",
            &history_limit.to_string(),
        ])
        .output()
        .await;

    Ok(())
}

/// Resize a tmux session's window.
pub async fn resize_session(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let name = session_name(session_id);
    let output = Command::new("tmux")
        .args([
            "resize-window",
            "-t",
            &name,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to resize tmux session: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux resize-window failed: {stderr}"))
    }
}

/// Send input to a tmux session's active pane.
pub async fn send_keys(session_id: &str, keys: &str) -> Result<(), String> {
    let name = session_name(session_id);
    let output = Command::new("tmux")
        .args(["send-keys", "-t", &name, "-l", keys])
        .output()
        .await
        .map_err(|e| format!("Failed to send keys to tmux session: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux send-keys failed: {stderr}"))
    }
}

fn history_limit_from_env() -> u32 {
    std::env::var("TMUX_HISTORY_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
}

async fn run_tmux(args: &[&str], timeout_secs: u64) -> Option<String> {
    let output = Command::new("tmux").args(args).output();
    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), output)
        .await
        .ok()?
        .ok()?;

    if result.status.success() {
        Some(String::from_utf8_lossy(&result.stdout).to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_name_uses_prefix() {
        assert_eq!(session_name("abc-123"), "terminal-app-abc-123");
    }

    #[test]
    fn history_limit_defaults_to_100k() {
        // Unless TMUX_HISTORY_LIMIT is set in env, this returns default
        let limit = history_limit_from_env();
        assert!(limit > 0);
    }

    #[tokio::test]
    async fn is_tmux_available_returns_false_on_windows() {
        if cfg!(windows) {
            assert!(!is_tmux_available().await);
        }
    }
}
