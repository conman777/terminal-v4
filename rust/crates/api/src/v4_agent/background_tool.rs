//! Agent-facing background actions. The caller supplies authenticated session
//! context and a manager retained beyond the lifetime of a turn.
use super::{
    BackgroundProcesses, BackgroundRequest, BackgroundScope, BackgroundSnapshot, BackgroundState,
};
use crate::v4_agent::interaction::{self, ActionScope, ApprovalRequest, Cancellation, Interaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Duration};

pub(crate) fn definitions() -> Vec<Value> {
    [
        ("background_start", "Start one host shell command after exact user approval. It continues across turns, is stopped on session deletion or shutdown, and has a maximum lifetime of 86400 seconds. Output is withheld because it may contain secrets. Unattended execution is disabled.", json!({"command":{"type":"string"},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":86400}}), vec!["command", "timeoutSeconds"]),
        ("background_status", "Get the state of an action in this session and workspace. Process output is withheld. Unknown means recovery could not confirm the outcome.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
        ("background_wait", "Wait up to 30 seconds for an action in this session and workspace, then return its current state. Cancelling the wait does not stop the action. Output is withheld.", json!({"actionId":{"type":"string"},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":30}}), vec!["actionId", "timeoutSeconds"]),
        ("background_cancel", "Request cancellation of an action owned by this session and workspace. Check status for the final outcome.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
        ("background_read_output", "Ask the user to review and approve releasing the current bounded output of an action in this session. Output is only available while the server retains it and may contain sensitive information.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub(crate) fn handles(name: &str) -> bool {
    matches!(
        name,
        "background_start"
            | "background_status"
            | "background_wait"
            | "background_cancel"
            | "background_read_output"
    )
}
pub(crate) fn action_id(scope: &ActionScope, call_id: &str) -> String {
    let mut hash = Sha256::new();
    for part in [&scope.turn_id, call_id] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hex::encode(hash.finalize())
}
fn format_snapshot(action_id: &str, snapshot: BackgroundSnapshot) -> String {
    let (state, code) = match snapshot.state {
        BackgroundState::Running => ("running", None),
        BackgroundState::Exited { code } => ("exited", code),
        BackgroundState::Cancelled => ("cancelled", None),
        BackgroundState::TimedOut => ("timed_out", None),
        BackgroundState::CleanupUnconfirmed => ("cleanup_unconfirmed", None),
        BackgroundState::FailedToStart => ("failed_to_start", None),
        BackgroundState::Unknown => ("unknown", None),
    };
    json!({"actionId":action_id,"state":state,"exitCode":code,"outputWithheld":snapshot.output_withheld,"stdoutTruncated":snapshot.stdout_truncated,"stderrTruncated":snapshot.stderr_truncated}).to_string()
}

/// The trusted per-turn actor behind every agent-facing background action. It
/// owns approval, session-incarnation and credential fencing; the tool layer
/// never reaches the process manager directly.
#[async_trait::async_trait]
pub(crate) trait BackgroundActor: Send + Sync {
    fn scope(&self) -> &ActionScope;
    async fn start(
        self: Arc<Self>,
        call_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<(String, BackgroundSnapshot), String>;
    async fn status(&self, action_id: &str) -> Result<BackgroundSnapshot, String>;
    async fn wait(&self, action_id: &str, timeout: Duration) -> Result<BackgroundSnapshot, String>;
    async fn cancel(&self, action_id: &str) -> Result<BackgroundSnapshot, String>;
    async fn review_output(
        &self,
        call_id: &str,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String>;
}

fn checked_arguments(name: &str, input: &Value) -> Result<(), String> {
    let schema = definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or("Unknown background tool")?;
    if input.as_object().is_none_or(|args| {
        args.keys()
            .any(|key| schema["parameters"]["properties"].get(key).is_none())
    }) {
        return Err("Unexpected background tool arguments".into());
    }
    Ok(())
}

fn checked_action_id(input: &Value) -> Result<&str, String> {
    input["actionId"]
        .as_str()
        .filter(|id| {
            id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or_else(|| "Invalid actionId".into())
}

/// Production dispatch: every operation goes through the turn's actor. Do not
/// wrap this future in a drop-on-cancellation select; start and output review
/// own an approval-to-admission transition and check cancellation themselves.
pub(crate) async fn execute_actor(
    actor: &Arc<dyn BackgroundActor>,
    call_id: &str,
    name: &str,
    input: &Value,
) -> Result<String, String> {
    if call_id.is_empty() || call_id.len() > 512 {
        return Err("Invalid trusted background session context".into());
    }
    checked_arguments(name, input)?;
    match name {
        "background_start" => {
            let command = input["command"].as_str().ok_or("Missing command")?;
            let timeout = input["timeoutSeconds"]
                .as_u64()
                .filter(|seconds| (1..=86400).contains(seconds))
                .ok_or("Invalid timeoutSeconds")?;
            if command.is_empty() || command.len() > 10000 || command.contains('\0') {
                return Err("Invalid command".into());
            }
            let (id, snapshot) = actor
                .clone()
                .start(call_id, command, Duration::from_secs(timeout))
                .await?;
            Ok(format_snapshot(&id, snapshot))
        }
        "background_status"
        | "background_cancel"
        | "background_wait"
        | "background_read_output" => {
            let id = checked_action_id(input)?;
            let snapshot = match name {
                "background_status" => actor.status(id).await?,
                "background_cancel" => actor.cancel(id).await?,
                "background_wait" => {
                    let seconds = input["timeoutSeconds"]
                        .as_u64()
                        .filter(|seconds| (1..=30).contains(seconds))
                        .ok_or("Invalid timeoutSeconds")?;
                    actor.wait(id, Duration::from_secs(seconds)).await?
                }
                _ => {
                    let snapshot = actor.review_output(call_id, id).await?;
                    return Ok(json!({
                        "actionId": id,
                        "stdout": snapshot.stdout,
                        "stderr": snapshot.stderr,
                        "stdoutTruncated": snapshot.stdout_truncated,
                        "stderrTruncated": snapshot.stderr_truncated,
                    })
                    .to_string());
                }
            };
            Ok(format_snapshot(id, snapshot))
        }
        _ => Err("Unknown background tool".into()),
    }
}

/// Legacy direct-manager prototype, kept only for manager-level tests. It
/// starts commands without the trusted actor (no session-incarnation fence) and
/// is not reachable from the agent loop.
pub(crate) async fn execute_direct(
    manager: &BackgroundProcesses,
    scope: &ActionScope,
    workspace: &Path,
    call_id: &str,
    name: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancellation: &Cancellation,
    authority: Option<&crate::auth::LocalAuthority>,
) -> Result<String, String> {
    cancellation.check()?;
    if scope.owner.is_empty()
        || scope.session_id.is_empty()
        || scope.turn_id.is_empty()
        || call_id.is_empty()
        || call_id.len() > 512
        || !workspace.is_absolute()
        || std::fs::canonicalize(workspace).ok().as_deref() != Some(workspace)
        || !workspace.is_dir()
    {
        return Err("Invalid trusted background session context".into());
    }
    let schema = definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or("Unknown background tool")?;
    if input.as_object().is_none_or(|args| {
        args.keys()
            .any(|key| schema["parameters"]["properties"].get(key).is_none())
    }) {
        return Err("Unexpected background tool arguments".into());
    }
    let background_scope = BackgroundScope {
        owner: scope.owner.clone(),
        session: scope.session_id.clone(),
        workspace: workspace.into(),
        incarnation: None,
    };
    let (generation, credential_expiry) = authority
        .and_then(|value| value.valid_for(&scope.owner, interaction::now_ms()))
        .ok_or("Background authorization is unavailable or expired")?;
    let authorization_generation = Some(generation);
    manager.ensure_authorized(&background_scope, authorization_generation)?;
    if name == "background_start" {
        let command = input["command"].as_str().ok_or("Missing command")?;
        let timeout = input["timeoutSeconds"]
            .as_u64()
            .filter(|seconds| (1..=86400).contains(seconds))
            .ok_or("Invalid timeoutSeconds")?;
        if command.is_empty() || command.len() > 10000 || command.contains('\0') {
            return Err("Invalid command".into());
        }
        cancellation
            .run(manager.ensure_session_open(&background_scope))
            .await?;
        let request = BackgroundRequest {
            scope: background_scope,
            authorization_generation,
            action_id: action_id(scope, call_id),
            command: command.into(),
            timeout: Duration::from_secs(timeout),
        };
        let expires_at = interaction::now_ms()
            .saturating_add(300_000)
            .min(credential_expiry);
        let approval = ApprovalRequest { id: uuid::Uuid::new_v4().to_string(), scope: scope.clone(), tool_call_id: call_id.into(), tool_name: name.into(), tool_input: input.clone(), description: format!("Background command (runs on this host; continues after this turn)\nWorkspace: {}\nExact arguments: {}", workspace.display(), serde_json::to_string_pretty(input).map_err(|_| "Cannot encode action")?), expires_at };
        let approved = cancellation.run(interaction.approve(approval)).await?;
        if !approved {
            return Err("User denied this exact background action".into());
        }
        let result = manager
            .start_checked(request.clone(), Some(&request), cancellation, expires_at)
            .await?;
        Ok(format_snapshot(&request.action_id, result))
    } else {
        let id = input["actionId"]
            .as_str()
            .filter(|id| {
                id.len() == 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            .ok_or("Invalid actionId")?;
        if name == "background_read_output" {
            manager.ensure_session_open(&background_scope).await?;
            let snapshot = manager.reviewable_output(&background_scope, id).await?;
            let reviewed = json!({
                "actionId": id,
                "stdout": snapshot.stdout,
                "stderr": snapshot.stderr,
                "stdoutTruncated": snapshot.stdout_truncated,
                "stderrTruncated": snapshot.stderr_truncated,
            });
            let expires_at = interaction::now_ms()
                .saturating_add(300_000)
                .min(credential_expiry);
            let request = ApprovalRequest {
                id: uuid::Uuid::new_v4().to_string(),
                scope: scope.clone(),
                tool_call_id: call_id.into(),
                tool_name: name.into(),
                tool_input: input.clone(),
                description: format!("Share this exact background command output with the agent? It may contain sensitive information.\nWorkspace: {}\n{}", workspace.display(), serde_json::to_string_pretty(&reviewed).map_err(|_| "Cannot encode output")?),
                expires_at,
            };
            if !cancellation.run(interaction.approve(request)).await? {
                return Err("User denied releasing background output".into());
            }
            cancellation.check()?;
            if interaction::now_ms() >= expires_at {
                return Err("Output approval expired".into());
            }
            manager.ensure_session_open(&background_scope).await?;
            cancellation.check()?;
            manager.ensure_authorized(&background_scope, authorization_generation)?;
            if interaction::now_ms() >= credential_expiry {
                return Err("Background authorization expired".into());
            }
            return Ok(reviewed.to_string());
        }
        if name == "background_wait" {
            let seconds = input["timeoutSeconds"]
                .as_u64()
                .filter(|seconds| (1..=30).contains(seconds))
                .ok_or("Invalid timeoutSeconds")?;
            let snapshot = manager
                .wait(
                    &background_scope,
                    id,
                    Duration::from_secs(seconds),
                    cancellation,
                )
                .await?;
            manager.ensure_authorized(&background_scope, authorization_generation)?;
            if interaction::now_ms() >= credential_expiry {
                return Err("Background authorization expired".into());
            }
            return Ok(format_snapshot(id, snapshot));
        }
        if name == "background_cancel" {
            manager.cancel(&background_scope, id).await?;
        }
        let snapshot = manager.snapshot(&background_scope, id).await?;
        if interaction::now_ms() >= credential_expiry {
            return Err("Background authorization expired".into());
        }
        Ok(format_snapshot(id, snapshot))
    }
}

#[cfg(test)]
#[path = "background_tool_tests.rs"]
mod tests;
