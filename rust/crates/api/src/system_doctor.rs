//! Setup check, like Hermes's `hermes doctor`: confirms the tools Terminal v4 relies on are installed.
use crate::{auth::AuthenticatedUser, state::AppState};
use axum::{routing::get, Extension, Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub ok: bool,
    pub detail: String,
    pub fix: &'static str,
    pub required: bool,
}

struct Tool {
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    fix: &'static str,
    required: bool,
}

const TOOLS: [Tool; 4] = [
    Tool {
        id: "git",
        label: "Git",
        program: "git",
        args: &["--version"],
        fix:
            "Install Git (on macOS: xcode-select --install). Branches, changes and commits need it.",
        required: true,
    },
    Tool {
        id: "claude",
        label: "Claude Code",
        program: "claude",
        args: &["--version"],
        fix: "Install Claude Code, then run `claude` once in a terminal to sign in.",
        required: false,
    },
    Tool {
        id: "codex",
        label: "Codex",
        program: "codex",
        args: &["--version"],
        fix: "Install the Codex CLI, then run `codex login` in a terminal.",
        required: false,
    },
    Tool {
        id: "gh",
        label: "GitHub CLI",
        program: "gh",
        args: &["--version"],
        fix: "Install the GitHub CLI and run `gh auth login` to create pull requests from threads.",
        required: false,
    },
];

async fn first_line(program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .chars()
            .take(120)
            .collect()
    })
}

async fn check_tool(tool: &Tool) -> Check {
    let version = first_line(tool.program, tool.args).await;
    Check {
        id: tool.id,
        label: tool.label,
        ok: version.is_some(),
        detail: version.unwrap_or_else(|| "Not found on this server's PATH".into()),
        fix: tool.fix,
        required: tool.required,
    }
}

fn data_dir_check(state: &AppState) -> Check {
    let dir = &state.config().data_dir;
    let writable =
        std::fs::create_dir_all(dir).is_ok() && tempfile::NamedTempFile::new_in(dir).is_ok();
    Check {
        id: "data",
        label: "Data folder",
        ok: writable,
        detail: dir.display().to_string(),
        fix: "Make the data folder writable, or set TERMINAL_DATA_DIR to a folder this server can write.",
        required: true,
    }
}

pub(crate) async fn run_checks(state: &AppState) -> Vec<Check> {
    let mut checks = vec![data_dir_check(state)];
    for tool in &TOOLS {
        checks.push(check_tool(tool).await);
    }
    checks
}

async fn doctor_route(
    axum::extract::State(state): axum::extract::State<AppState>,
    Extension(_user): Extension<AuthenticatedUser>,
) -> Json<Value> {
    let checks = run_checks(&state).await;
    let agent_ready = checks
        .iter()
        .any(|check| matches!(check.id, "claude" | "codex") && check.ok);
    let ready = agent_ready && checks.iter().all(|check| check.ok || !check.required);
    Json(json!({ "ready": ready, "agentReady": agent_ready, "checks": checks }))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/system/doctor", get(doctor_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_missing_tools_with_a_fix() {
        let missing = check_tool(&Tool {
            id: "missing",
            label: "Missing tool",
            program: "terminal-v4-definitely-missing-tool",
            args: &["--version"],
            fix: "Install it.",
            required: false,
        })
        .await;
        let present = check_tool(&TOOLS[0]).await;
        assert_eq!(
            (
                missing.ok,
                missing.detail.as_str(),
                missing.fix,
                present.ok,
                present.detail.starts_with("git version")
            ),
            (
                false,
                "Not found on this server's PATH",
                "Install it.",
                true,
                true
            )
        );
    }

    #[tokio::test]
    async fn checks_the_data_folder_can_be_written() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::new(terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        })
        .unwrap();
        let checks = run_checks(&state).await;
        assert_eq!(
            (checks.len(), checks[0].id, checks[0].ok),
            (5, "data", true)
        );
    }
}
