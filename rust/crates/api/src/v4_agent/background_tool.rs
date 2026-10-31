//! Agent-facing background actions. The caller supplies authenticated session
//! context and a manager retained beyond the lifetime of a turn.
#[cfg(test)]
use super::{BackgroundProcesses, BackgroundRequest, BackgroundScope};
use super::{BackgroundSnapshot, BackgroundState};
use crate::v4_agent::interaction::ActionScope;
#[cfg(test)]
use crate::v4_agent::interaction::{self, ApprovalRequest, Cancellation, Interaction};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::Path;
use std::{sync::Arc, time::Duration};

pub(crate) fn definitions() -> Vec<Value> {
    [
        ("background_start", "Start one host shell command after exact user approval. Set interactive to true to allow separately approved input. It continues across turns, is stopped on session deletion or shutdown, and has a maximum lifetime of 86400 seconds. Output is withheld because it may contain secrets. Unattended execution is disabled.", json!({"command":{"type":"string"},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":86400},"interactive":{"type":"boolean"}}), vec!["command", "timeoutSeconds"]),
        ("background_list", "List retained action IDs and states for this session and workspace, including indexed receipts after restart. History is bounded and may omit older unindexed or pruned actions; memory-only entries may disappear after restart. Commands and output are withheld.", json!({}), vec![]),
        ("background_status", "Get the state of an action in this session and workspace. Process output is withheld. Unknown means recovery could not confirm the outcome.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
        ("background_wait", "Wait up to 30 seconds for an action in this session and workspace, then return its current state. Cancelling the wait does not stop the action. Output is withheld.", json!({"actionId":{"type":"string"},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":30}}), vec!["actionId", "timeoutSeconds"]),
        ("background_wait_output", "Wait up to 30 seconds for output activity or exit. Pass afterRevision 0 initially and then the last returned outputRevision. This returns metadata only; reading output requires private user review. Revisions are process-local and unavailable after eviction or restart.", json!({"actionId":{"type":"string"},"afterRevision":{"type":"integer","minimum":0},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":30}}), vec!["actionId", "afterRevision", "timeoutSeconds"]),
        ("background_follow_output", "Wait up to 30 seconds for output activity or exit. If output changed, ask the user to privately review the exact recent bounded stdout and stderr before sharing them. Pass afterRevision 0 initially, then the last returned outputRevision. Windows can overlap; earlier output can be omitted. Revisions and output are unavailable after eviction or restart.", json!({"actionId":{"type":"string"},"afterRevision":{"type":"integer","minimum":0},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":30}}), vec!["actionId", "afterRevision", "timeoutSeconds"]),
        ("background_cancel", "Request cancellation of an action owned by this session and workspace. Check status for the final outcome.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
        ("background_write", "Request separate approval to write up to 512 UTF-8 bytes to a running interactive command in this session. A successful write only confirms acceptance by the pipe, not consumption by the command. An uncertain result must never be retried automatically.", json!({"actionId":{"type":"string"},"text":{"type":"string"}}), vec!["actionId", "text"]),
        ("background_write_bytes", "Request separate approval to write up to 512 binary bytes, encoded as standard padded Base64, to a running interactive command. The approval displays the exact bytes in hexadecimal. Pipe acceptance does not confirm consumption; never automatically retry an uncertain result.", json!({"actionId":{"type":"string"},"base64":{"type":"string"}}), vec!["actionId", "base64"]),
        ("background_close_input", "Request separate approval to close input to a running interactive command, allowing it to see end-of-file. This confirms the local input handle is closed, not that the command consumed end-of-file. An uncertain result must never be retried automatically.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
        ("background_read_output", "Request private user review of the current bounded output snapshot. Only the exact approved snapshot is shared with the agent and conversation history. Denied output remains withheld; output is unavailable after eviction or restart.", json!({"actionId":{"type":"string"}}), vec!["actionId"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub(crate) fn handles(name: &str) -> bool {
    matches!(
        name,
        "background_start"
            | "background_list"
            | "background_status"
            | "background_wait"
            | "background_wait_output"
            | "background_follow_output"
            | "background_cancel"
            | "background_write"
            | "background_write_bytes"
            | "background_close_input"
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
    snapshot_json(action_id, snapshot).to_string()
}

fn snapshot_json(action_id: &str, snapshot: BackgroundSnapshot) -> Value {
    let (state, code) = match snapshot.state {
        BackgroundState::Running => ("running", None),
        BackgroundState::Exited { code } => ("exited", code),
        BackgroundState::Cancelled => ("cancelled", None),
        BackgroundState::TimedOut => ("timed_out", None),
        BackgroundState::CleanupUnconfirmed => ("cleanup_unconfirmed", None),
        BackgroundState::FailedToStart => ("failed_to_start", None),
        BackgroundState::Unknown => ("unknown", None),
    };
    json!({"actionId":action_id,"state":state,"exitCode":code,"outputWithheld":snapshot.output_withheld,"stdoutTruncated":snapshot.stdout_truncated,"stderrTruncated":snapshot.stderr_truncated})
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
    async fn start_interactive(
        self: Arc<Self>,
        call_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<(String, BackgroundSnapshot), String>;
    async fn write_input(&self, call_id: &str, action_id: &str, text: &str) -> Result<(), String>;
    async fn write_bytes(
        &self,
        call_id: &str,
        action_id: &str,
        encoded: &str,
    ) -> Result<(), String>;
    async fn close_input(&self, call_id: &str, action_id: &str) -> Result<(), String>;
    async fn list(&self) -> Result<Vec<(String, BackgroundSnapshot)>, String>;
    async fn status(&self, action_id: &str) -> Result<BackgroundSnapshot, String>;
    async fn wait(&self, action_id: &str, timeout: Duration) -> Result<BackgroundSnapshot, String>;
    async fn wait_output(
        &self,
        action_id: &str,
        after_revision: u64,
        timeout: Duration,
    ) -> Result<(BackgroundSnapshot, u64), String>;
    async fn cancel(&self, action_id: &str) -> Result<BackgroundSnapshot, String>;
    async fn review_output(
        &self,
        call_id: &str,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String>;
    async fn follow_output(
        &self,
        call_id: &str,
        action_id: &str,
        after_revision: u64,
        timeout: Duration,
    ) -> Result<(BackgroundSnapshot, u64, Option<BackgroundSnapshot>), String>;
    #[cfg(unix)]
    async fn private_preview(
        &self,
        approval_id: &str,
        action_id: &str,
        context: &crate::structured::PairedDecisionContext,
    ) -> Result<(String, Value), String>;
    #[cfg(unix)]
    async fn private_decision(
        &self,
        approval_id: &str,
        action_id: &str,
        token: &str,
        context: &crate::structured::PairedDecisionContext,
    ) -> Result<crate::v4_agent::interaction::DecisionReceipt, String>;
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

pub(crate) fn checked_binary_input(encoded: &str) -> Result<Vec<u8>, String> {
    let limit = super::watchdog::MAX_INPUT_BYTES;
    if encoded.is_empty() || encoded.len() > limit.div_ceil(3) * 4 {
        return Err("Invalid binary background input".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid binary background input")?;
    if bytes.is_empty() || bytes.len() > limit || STANDARD.encode(&bytes) != encoded {
        return Err("Invalid binary background input".into());
    }
    Ok(bytes)
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
        "background_list" => {
            let actions = actor
                .list()
                .await?
                .into_iter()
                .map(|(id, snapshot)| snapshot_json(&id, snapshot))
                .collect::<Vec<_>>();
            Ok(
                json!({"retention":"bounded_durable_and_memory", "historyIncomplete":true, "memoryOnlyEntriesMayDisappear":true, "actions":actions})
                    .to_string(),
            )
        }
        "background_start" => {
            let command = input["command"].as_str().ok_or("Missing command")?;
            let timeout = input["timeoutSeconds"]
                .as_u64()
                .filter(|seconds| (1..=86400).contains(seconds))
                .ok_or("Invalid timeoutSeconds")?;
            if command.is_empty() || command.len() > 10000 || command.contains('\0') {
                return Err("Invalid command".into());
            }
            let interactive = match input.get("interactive") {
                Some(value) => value.as_bool().ok_or("Invalid interactive setting")?,
                None => false,
            };
            let (id, snapshot) = if interactive {
                actor
                    .clone()
                    .start_interactive(call_id, command, Duration::from_secs(timeout))
                    .await?
            } else {
                actor
                    .clone()
                    .start(call_id, command, Duration::from_secs(timeout))
                    .await?
            };
            Ok(format_snapshot(&id, snapshot))
        }
        "background_write" => {
            let id = checked_action_id(input)?;
            let text = input["text"]
                .as_str()
                .filter(|value| {
                    !value.is_empty() && value.len() <= super::watchdog::MAX_INPUT_BYTES
                })
                .ok_or("Invalid background input")?;
            actor.write_input(call_id, id, text).await?;
            Ok(json!({"actionId":id,"state":"written_to_pipe","bytes":text.len(),"consumptionConfirmed":false}).to_string())
        }
        "background_write_bytes" => {
            let id = checked_action_id(input)?;
            let encoded = input["base64"]
                .as_str()
                .ok_or("Invalid binary background input")?;
            let bytes = checked_binary_input(encoded)?;
            actor.write_bytes(call_id, id, encoded).await?;
            Ok(json!({"actionId":id,"state":"written_to_pipe","bytes":bytes.len(),"consumptionConfirmed":false}).to_string())
        }
        "background_close_input" => {
            let id = checked_action_id(input)?;
            actor.close_input(call_id, id).await?;
            Ok(
                json!({"actionId":id,"state":"input_closed","eofConsumptionConfirmed":false})
                    .to_string(),
            )
        }
        "background_status"
        | "background_cancel"
        | "background_wait"
        | "background_wait_output"
        | "background_follow_output"
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
                "background_wait_output" => {
                    let seconds = input["timeoutSeconds"]
                        .as_u64()
                        .filter(|seconds| (1..=30).contains(seconds))
                        .ok_or("Invalid timeoutSeconds")?;
                    let after = input["afterRevision"]
                        .as_u64()
                        .ok_or("Invalid afterRevision")?;
                    let (snapshot, revision) = actor
                        .wait_output(id, after, Duration::from_secs(seconds))
                        .await?;
                    let mut value = snapshot_json(id, snapshot);
                    value["outputRevision"] = json!(revision);
                    value["retention"] = json!("current_server_memory_only");
                    return Ok(value.to_string());
                }
                "background_follow_output" => {
                    let seconds = input["timeoutSeconds"]
                        .as_u64()
                        .filter(|seconds| (1..=30).contains(seconds))
                        .ok_or("Invalid timeoutSeconds")?;
                    let after = input["afterRevision"]
                        .as_u64()
                        .ok_or("Invalid afterRevision")?;
                    let (status, revision, released) = actor
                        .follow_output(call_id, id, after, Duration::from_secs(seconds))
                        .await?;
                    let mut value = snapshot_json(id, status);
                    value["outputRevision"] = json!(revision);
                    value["retention"] = json!("current_server_memory_only");
                    value["outputChanged"] = json!(released.is_some());
                    if let Some(output) = released {
                        value["window"] = json!("tail");
                        value["stdout"] = json!(output.stdout);
                        value["stderr"] = json!(output.stderr);
                        value["stdoutTruncated"] = json!(output.stdout_truncated);
                        value["stderrTruncated"] = json!(output.stderr_truncated);
                        value["outputWithheld"] = json!(false);
                    }
                    return Ok(value.to_string());
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
#[cfg(test)]
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
        if input
            .get("interactive")
            .is_some_and(|value| value != &json!(false))
        {
            return Err("Interactive starts require the trusted background actor".into());
        }
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
            interactive: false,
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
