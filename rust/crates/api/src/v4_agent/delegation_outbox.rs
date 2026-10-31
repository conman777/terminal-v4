//! Durable delegation records and supervised read-only child execution.
//!
//! Integration must authenticate the owner and parent, bind the real child/task, and
//! serialize each parent's lifecycle and queue operations. Never recreate a missing
//! parent or infer safe retry from a missing receipt. The queue receipt omits its
//! payload: verification must check the exact mutation under the parent actor/gate.
//! A revision conflict or uncertain queue outcome requires review.
//!
//! One process holds an exclusive nonblocking flock for the ledger's lifetime; all
//! threads share its mutex. SQLite transactions use FULL synchronization and DELETE
//! journaling on a local filesystem with working locks, atomic filesystem operations,
//! and durable fsync. Network filesystems, malicious processes with the same OS user,
//! directory replacement by a privileged actor, missing rollback journals, and disk
//! rollback are not supported.
//! Creation is explicit; opening a damaged or missing ledger never recreates it.

use crate::followup_queue::{Mutation, MutationReceipt, QueueOperation};
#[cfg(unix)]
use rusqlite::OpenFlags;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const MAX_RECORDS: i64 = 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_QUEUE_TEXT_BYTES: usize = 100_000;
const MAX_PROMPT_BYTES: usize = 200_000;
const MAX_WORKSPACE_BYTES: usize = 4096;
#[cfg(unix)]
const MAX_DB_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub owner: String,
    pub data_root: String,
    pub parent_session: String,
    pub parent_turn: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_incarnation: Option<Uuid>,
    pub queue_identity: Uuid,
    pub child_session: String,
    pub task: String,
    pub workspace: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub permission: Permission,
    pub operation_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<DelegationAuthorization>,
    #[cfg(unix)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    // Origin metadata only; delivery requires a separately protected proof.
    pub paired_authorization: Option<crate::paired_environments::PairedGrantAuthority>,
    #[cfg(unix)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_attestation: Option<crate::followup_queue::PairedDelegationAttestation>,
}

/// The initiating credential's non-secret authority, bound to the parent
/// incarnation. Legacy and paired approvals have no such local authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DelegationAuthorization {
    pub session_incarnation: Uuid,
    pub generation: i64,
    pub expires_at_ms: i64,
}

impl Binding {
    pub(super) fn task_input(&self) -> crate::workspace_tasks::TaskInput {
        crate::workspace_tasks::TaskInput {
            workspace_path: self.workspace.clone(),
            provider: self.provider.clone(),
            prompt: self.prompt.clone(),
            model: Some(self.model.clone()),
            parent_session_id: Some(self.parent_session.clone()),
            parent_task_id: None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Permission {
    ReadOnlyChild,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Outcome {
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Terminal {
    pub outcome: Outcome,
    pub result: String,
    pub mutation: Mutation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_digest: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Record {
    pub binding: Binding,
    pub terminal: Option<Terminal>,
    pub receipt: Option<MutationReceipt>,
    child_proof: Option<ChildProof>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildProof {
    session_id: String,
    result_sha256: String,
    displayed_sha256: String,
    displayed_truncated_sha256: String,
    is_error: bool,
    exit_code: i32,
}

fn validate_child_proof(binding: &Binding, proof: &ChildProof) -> Result<()> {
    let id = Uuid::parse_str(&proof.session_id).map_err(|_| "Invalid child result receipt")?;
    let digests_valid = [
        &proof.result_sha256,
        &proof.displayed_sha256,
        &proof.displayed_truncated_sha256,
    ]
    .iter()
    .all(|value| {
        hex::decode(value).is_ok_and(|digest| digest.len() == 32 && hex::encode(digest) == **value)
    });
    if id.is_nil()
        || id.to_string() != proof.session_id
        || proof.session_id != binding.child_session
        || !digests_valid
        || proof.exit_code != if proof.is_error { 1 } else { 0 }
    {
        return Err("Invalid child result receipt".into());
    }
    Ok(())
}

fn result_digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(
        crate::session_search::safe_history_text(text).as_bytes(),
    ))
}
fn displayed_result(source: &str, truncated: bool) -> String {
    let mut result = crate::session_search::safe_history_text(source);
    let truncated = truncated || result.len() > 48_000;
    if result.len() > 48_000 {
        let mut end = 48_000;
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        result.truncate(end);
    }
    if result.trim().is_empty() {
        result = "No answer was returned.".into();
    }
    if truncated {
        result.push_str("\n[Result truncated]");
    }
    result
}

async fn read_child_pipe<R: tokio::io::AsyncRead + Unpin>(
    mut pipe: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    use tokio::io::AsyncReadExt;
    let mut retained = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        let size = pipe.read(&mut chunk).await?;
        if size == 0 {
            return Ok((retained, truncated));
        }
        let keep = size.min(limit.saturating_sub(retained.len()));
        retained.extend_from_slice(&chunk[..keep]);
        truncated |= keep != size;
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Admission {
    New,
    Existing,
}

pub(super) struct Outbox {
    db: Mutex<Connection>,
    data_root: PathBuf,
    _lock: File,
    _provision_guard: Option<File>,
}

#[cfg(unix)]
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct OutboxIdentity {
    version: u8,
    data_root: String,
    root: (u64, u64),
    directory: (u64, u64),
    lock: (u64, u64),
    database: (u64, u64),
}

#[cfg(unix)]
pub(crate) fn provision_supervisor(data: &Path) -> Result<Arc<DelegationSupervisor>> {
    let data = data
        .canonicalize()
        .map_err(|_| "Outbox data directory is unavailable")?;
    let outbox = Arc::new(Outbox::open_or_provision(&data)?);
    Ok(Arc::new(DelegationSupervisor::new(outbox)?))
}

#[cfg(unix)]
pub(crate) fn open_existing_supervisor(data: &Path) -> Result<Arc<DelegationSupervisor>> {
    let data = data
        .canonicalize()
        .map_err(|_| "Outbox data directory is unavailable")?;
    let outbox = Arc::new(Outbox::open_existing(&data)?);
    Ok(Arc::new(DelegationSupervisor::new(outbox)?))
}

#[cfg(unix)]
pub(crate) struct DelegationSupervisor {
    outbox: Arc<Outbox>,
    state: Mutex<SupervisorState>,
    owner_cleanup:
        Mutex<std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>,
    cleanup_instance: Uuid,
}

#[cfg(unix)]
pub(crate) struct DelegationTurn {
    manager: crate::structured::StructuredSessionManager,
    supervisor: Arc<DelegationSupervisor>,
    pub(super) scope: super::interaction::ActionScope,
    generation: u64,
    paired_authority: Option<crate::paired_environments::PairedGrantAuthority>,
    #[cfg(test)]
    test_command: Mutex<Option<Box<dyn FnOnce(&mut tokio::process::Command) + Send>>>,
}

#[cfg(unix)]
pub(crate) struct DelegationInvocation<'a> {
    pub(crate) scope: &'a super::interaction::ActionScope,
    pub(crate) interaction: &'a dyn super::interaction::Interaction,
    pub(crate) cancellation: &'a super::interaction::Cancellation,
    pub(crate) resources: &'a Arc<super::interaction::TurnResources>,
    pub(crate) authority: Option<&'a crate::auth::LocalAuthority>,
}

#[cfg(unix)]
impl DelegationTurn {
    pub(crate) fn new(
        manager: crate::structured::StructuredSessionManager,
        supervisor: Arc<DelegationSupervisor>,
        scope: super::interaction::ActionScope,
        generation: u64,
    ) -> Result<Self> {
        if !manager.has_delegation_supervisor(&supervisor)
            || scope.owner.is_empty()
            || scope.session_id.is_empty()
            || scope.turn_id.is_empty()
            || generation == 0
        {
            return Err("Delegation turn scope is unavailable".into());
        }
        Ok(Self {
            manager,
            supervisor,
            scope,
            generation,
            paired_authority: None,
            #[cfg(test)]
            test_command: Mutex::new(None),
        })
    }

    pub(crate) fn with_paired_authority(
        mut self,
        grant: Option<crate::paired_environments::PairedGrantAuthority>,
    ) -> Self {
        self.paired_authority =
            grant.filter(|grant| grant.valid_for(&self.scope.owner, super::interaction::now_ms()));
        self
    }

    #[cfg(test)]
    pub(crate) fn set_test_command(
        &self,
        command: impl FnOnce(&mut tokio::process::Command) + Send + 'static,
    ) {
        *self.test_command.lock().unwrap() = Some(Box::new(command));
    }

    pub(crate) async fn execute(
        self: &Arc<Self>,
        data: &Path,
        session: &super::Session,
        call_id: &str,
        input: &serde_json::Value,
        invocation: DelegationInvocation<'_>,
    ) -> Result<String> {
        let DelegationInvocation {
            scope,
            interaction,
            cancellation,
            resources,
            authority,
        } = invocation;
        let owner = scope.owner.as_str();
        if scope != &self.scope
            || data.canonicalize().ok().as_deref() != Some(self.supervisor.data_root())
        {
            return Err("Delegation turn scope changed".into());
        }
        cancellation.check()?;
        let parent = self
            .manager
            .prepare_delegation_queue_binding(
                owner,
                &scope.session_id,
                Path::new(&session.workspace),
                self.generation,
                resources,
            )
            .await
            .map_err(|error| error.message)?;
        let identity = parent.identity;
        let parent_incarnation = parent.incarnation.ok_or(
            "Background delegation requires a conversation with a durable session identity",
        )?;
        let authorization = parent.incarnation.and_then(|session_incarnation| {
            authority
                .and_then(|authority| authority.valid_for(owner, super::interaction::now_ms()))
                .map(|(generation, expires_at_ms)| DelegationAuthorization {
                    session_incarnation,
                    generation,
                    expires_at_ms,
                })
        });
        cancellation.check()?;
        let approved = super::delegation_review::review_with_authorization(
            data,
            owner,
            session,
            scope,
            identity,
            Some(parent_incarnation),
            authorization,
            self.paired_authority.clone(),
            call_id,
            input,
            interaction,
            cancellation,
        )
        .await?;
        let binding = approved.binding().clone();
        let turn = Arc::clone(self);
        let worker_data = data.to_path_buf();
        let worker_cancel = cancellation.clone();
        let started = tokio::spawn(async move {
            let mut approved = approved;
            let _owner_permit = turn
                .manager
                .external_owner_admission(&approved.binding().owner)?;
            if let Some(grant) = approved.binding().paired_authorization.clone() {
                let reviewed_binding = paired_attestation_binding(approved.binding())?;
                let queue = crate::followup_queue::QueueStore::new(
                    &worker_data,
                    crate::structured::queue::boot_id(),
                ).fail_fast();
                let proof = approved.admit_launch(|| {
                    turn.manager.with_delegation_paired_authority(
                        &approved.binding().owner,
                        &grant,
                        |check| queue.protect_paired_delegation_binding(
                            &approved.binding().owner,
                            &grant,
                            &reviewed_binding,
                            &|| {
                                approved.check_expiry()?;
                                approved.check_directories()?;
                                check()
                            },
                        ).map_err(|error| format!("{error:?}")),
                    )
                })?;
                approved.attach_paired_attestation(proof)?;
            }
            let worker_binding = approved.binding().clone();
            if let Some(claims) = &worker_binding.authorization {
                let authority = crate::auth::LocalAuthority::from_persisted_queue_claims(
                    &worker_binding.owner,
                    claims.generation,
                    claims.expires_at_ms,
                )?;
                let queue = crate::followup_queue::QueueStore::new(
                    &worker_data,
                    crate::structured::queue::boot_id(),
                ).fail_fast();
                approved.admit_launch(|| {
                    turn.manager.with_delegation_local_authority(
                        &worker_binding.owner,
                        &authority,
                        "Queue authority initialization outcome is uncertain; retry the delegation. No child was started.",
                        |check| {
                            queue
                                .initialize_authority_checked(&|| {
                                    approved.check_expiry()?;
                                    approved.check_directories()?;
                                    check()
                                })
                                .map_err(|error| format!("{error:?}"))
                        },
                    )
                })?;
            }
            let prepared = turn
                .supervisor
                .outbox
                .prepare_authorized_held_child(&worker_data, approved)
                .await;
            #[allow(unused_mut)]
            let (_, mut child) = match prepared {
                Ok(child) => child,
                Err(error) => {
                    if turn
                        .supervisor
                        .outbox
                        .read(&worker_binding.owner, worker_binding.operation_id)?
                        .is_some()
                    {
                        turn.settle_unlaunched(&worker_binding)
                            .await
                            .map_err(|_| format!("{error}; delegation admission needs recovery"))?;
                    }
                    return Err(error);
                }
            };
            #[cfg(test)]
            {
                let command = turn
                    .test_command
                    .lock()
                    .map_err(|_| "Test command unavailable")?
                    .take();
                if let Some(command) = command {
                    command(&mut child.command);
                }
            }
            match turn.supervisor.start(
                turn.manager.clone(),
                worker_binding.clone(),
                child,
                worker_cancel,
            ) {
                Ok(started) => Ok(started),
                Err(error) => {
                    turn.settle_unlaunched(&worker_binding)
                        .await
                        .map_err(|_| format!("{error}; delegation admission needs recovery"))?;
                    Err(error)
                }
            }
        })
        .await
        .map_err(|_| "Delegation admission outcome is uncertain; check recovery")??;
        let task = started
            .await
            .map_err(|_| "Delegation launch outcome is uncertain")??;
        let delivery = if binding.authorization.is_none() && binding.paired_authorization.is_none()
        {
            "If delivery can be completed, the result will enter the held follow-up queue for review. Otherwise, review the retained task result."
        } else {
            match self.manager.activate_delegation_delivery(
            owner, &scope.session_id, Path::new(&session.workspace),
            crate::structured::queue::DelegationQueueTarget {
                identity, operation: binding.operation_id, generation: self.generation, incarnation: binding.parent_incarnation,
            }, cancellation,
        ).await {
            Ok(true) => "If the initiating authorization remains valid, the result will enter the parent follow-up queue and run when the conversation is idle. Otherwise, review the retained task result.",
                Ok(false) => "If the initiating authorization remains valid, the result will enter the held parent follow-up queue and requires resume. Otherwise, review the retained task result.",
                Err(_) => "Check the parent queue and retained task result before resuming; delivery may require review.",
        }
        };
        Ok(serde_json::json!({"status":"running", "taskId":task.id, "childSessionId":binding.child_session,
            "delivery":delivery}).to_string())
    }

    async fn settle_unlaunched(&self, binding: &Binding) -> Result<()> {
        crate::workspace_tasks::interrupt_unlaunched_delegation(
            self.supervisor.data_root().to_path_buf(),
            binding.owner.clone(),
            Uuid::parse_str(&binding.task).map_err(|_| "Invalid task ID")?,
            Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid child session")?,
            binding.task_input(),
        )
        .await
        .map_err(|error| error.message)?;
        self.supervisor
            .outbox
            .stage_persisted_task_result(&binding.owner, binding.operation_id, 0)
            .await?
            .ok_or("Delegated task outcome is unavailable")?;
        Ok(())
    }
}

#[cfg(unix)]
#[derive(Default)]
struct SupervisorState {
    closing: bool,
    fenced_owners: std::collections::HashSet<String>,
    retired_sessions: std::collections::HashSet<(String, String)>,
    recovering_owners: std::collections::HashSet<String>,
    recent_recovery: std::collections::HashMap<String, std::time::Instant>,
    startup_pending: std::collections::HashSet<(String, Uuid)>,
    children: std::collections::HashMap<Uuid, SupervisedChild>,
    cleanup_requests: std::collections::HashMap<String, Uuid>,
}

#[cfg(unix)]
struct SupervisedChild {
    owner: String,
    parent: String,
    shutdown: super::interaction::Cancellation,
    completion: tokio::sync::watch::Receiver<Option<Result<()>>>,
}

#[cfg(unix)]
pub(crate) struct OwnerRecovery {
    supervisor: Arc<DelegationSupervisor>,
    owner: String,
}

#[cfg(unix)]
impl Drop for OwnerRecovery {
    fn drop(&mut self) {
        if let Ok(mut state) = self.supervisor.state.lock() {
            state.recovering_owners.remove(&self.owner);
        }
    }
}

#[cfg(unix)]
impl DelegationSupervisor {
    pub(super) fn new(outbox: Arc<Outbox>) -> Result<Self> {
        let pending = outbox.startup_pending()?;
        Ok(Self {
            outbox,
            state: Mutex::new(SupervisorState {
                startup_pending: pending,
                ..Default::default()
            }),
            owner_cleanup: Mutex::new(std::collections::HashMap::new()),
            cleanup_instance: Uuid::new_v4(),
        })
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.outbox.data_root
    }

    pub(crate) fn parent_has_outstanding(
        &self,
        owner: &str,
        parent: &str,
        incarnation: Uuid,
    ) -> Result<bool> {
        if !valid_identity(owner) || !valid_identity(parent) || incarnation.is_nil() {
            return Err("Invalid delegation parent".into());
        }
        let state = self
            .state
            .try_lock()
            .map_err(|_| "Delegation supervisor is busy")?;
        if state.closing
            || state.fenced_owners.contains(owner)
            || state
                .retired_sessions
                .contains(&(owner.into(), parent.into()))
        {
            return Err("Delegation parent is unavailable".into());
        }
        if state.children.values().any(|child| {
            child.owner == owner
                && child.parent == parent
                && !matches!(&*child.completion.borrow(), Some(Ok(())))
        }) {
            return Ok(true);
        }
        drop(state);
        let db = self
            .outbox
            .db
            .try_lock()
            .map_err(|_| "Delegation outbox is busy")?;
        let mut statement = db.prepare("SELECT operation_id, binding, terminal, receipt, child_proof FROM records WHERE owner=?1 ORDER BY operation_id")
            .map_err(|_| "Cannot inspect delegated work")?;
        let mut rows = statement
            .query(params![owner])
            .map_err(|_| "Cannot inspect delegated work")?;
        let mut count = 0;
        while let Some(row) = rows.next().map_err(|_| "Cannot inspect delegated work")? {
            count += 1;
            if count > MAX_RECORDS {
                return Err("Outbox record capacity exceeded".into());
            }
            let operation: String = row.get(0).map_err(|_| "Corrupt outbox record")?;
            let record = parse_record(
                row.get(1).map_err(|_| "Corrupt outbox record")?,
                row.get(2).map_err(|_| "Corrupt outbox record")?,
                row.get(3).map_err(|_| "Corrupt outbox record")?,
                row.get(4).map_err(|_| "Corrupt outbox record")?,
            )?;
            if record.binding.owner != owner || record.binding.operation_id.to_string() != operation
            {
                return Err("Inconsistent outbox identity".into());
            }
            if record.binding.parent_session == parent
                && (record.binding.parent_incarnation != Some(incarnation)
                    || record.terminal.is_none()
                    || record.receipt.is_none())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(test)]
    pub(crate) fn seed_test_outstanding_parent(
        &self,
        owner: &str,
        parent: &str,
        incarnation: Uuid,
        workspace: &Path,
    ) -> Result<()> {
        let binding = Binding {
            owner: owner.into(),
            data_root: self.outbox.data_root.to_string_lossy().into_owned(),
            parent_session: parent.into(),
            parent_turn: "fixture-turn".into(),
            parent_incarnation: Some(incarnation),
            queue_identity: Uuid::new_v4(),
            child_session: Uuid::new_v4().to_string(),
            task: Uuid::new_v4().to_string(),
            workspace: workspace.to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: "deepseek-chat".into(),
            prompt: "Inspect the fixture".into(),
            permission: Permission::ReadOnlyChild,
            operation_id: Uuid::new_v4(),
            authorization: None,
            #[cfg(unix)]
            paired_authorization: None,
            #[cfg(unix)]
            paired_attestation: None,
        };
        self.outbox.admit(&binding).map(|_| ())
    }

    pub(crate) async fn lock_owner_cleanup(
        &self,
        owner: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        if !valid_identity(owner) {
            return Err("Invalid delegation owner".into());
        }
        let gate = {
            let mut owners = self
                .owner_cleanup
                .lock()
                .map_err(|_| "Delegation cleanup is unavailable")?;
            owners.retain(|_, gate| gate.strong_count() > 0);
            if let Some(gate) = owners.get(owner).and_then(std::sync::Weak::upgrade) {
                gate
            } else {
                if owners.len() >= 4096 {
                    return Err("Delegation cleanup capacity reached".into());
                }
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                owners.insert(owner.into(), Arc::downgrade(&gate));
                gate
            }
        };
        Ok(gate.lock_owned().await)
    }

    pub(crate) fn begin_owner_recovery(self: &Arc<Self>, owner: &str) -> Option<OwnerRecovery> {
        let mut state = self.state.lock().ok()?;
        let now = std::time::Instant::now();
        state
            .recent_recovery
            .retain(|_, at| now.duration_since(*at) < std::time::Duration::from_secs(5));
        if state.closing
            || state.fenced_owners.contains(owner)
            || !state.recovering_owners.insert(owner.into())
        {
            return None;
        }
        if state.recent_recovery.contains_key(owner) {
            state.recovering_owners.remove(owner);
            return None;
        }
        state.recent_recovery.insert(owner.into(), now);
        Some(OwnerRecovery {
            supervisor: Arc::clone(self),
            owner: owner.into(),
        })
    }

    pub(crate) async fn recover_ready(
        self: &Arc<Self>,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
    ) -> Result<()> {
        for record in self.outbox.list(owner)? {
            if record.receipt.is_some() {
                continue;
            }
            let binding = record.binding;
            if record.terminal.is_none() {
                let startup = self
                    .state
                    .lock()
                    .map_err(|_| "Delegation supervisor unavailable")?
                    .startup_pending
                    .contains(&(owner.into(), binding.operation_id));
                if startup {
                    let manager_root = self.outbox.data_root.clone();
                    let recovery_binding = binding.clone();
                    let supervisor = Arc::clone(self);
                    let shutdown = super::interaction::Cancellation::default();
                    let outcome = manager
                        .with_bound_parent_launch(
                            owner,
                            &manager_root,
                            &binding.parent_session,
                            Path::new(&binding.workspace),
                            binding.queue_identity,
                            binding.parent_incarnation,
                            &shutdown,
                            || async move {
                                tokio::task::spawn_blocking(move || {
                                    let task_id = Uuid::parse_str(&recovery_binding.task)
                                        .map_err(|_| "Invalid task ID")?;
                                    let child_id = Uuid::parse_str(&recovery_binding.child_session)
                                        .map_err(|_| "Invalid child session")?;
                                    crate::workspace_tasks::recover_unfinished_delegation(
                                        &supervisor.outbox.data_root,
                                        &recovery_binding.owner,
                                        task_id,
                                        child_id,
                                        &recovery_binding.task_input(),
                                        || {
                                            let state = supervisor.state.lock().map_err(|_| {
                                                crate::ApiError::internal(
                                                    "Delegation supervisor unavailable",
                                                )
                                            })?;
                                            if state.closing
                                                || state
                                                    .fenced_owners
                                                    .contains(&recovery_binding.owner)
                                                || state.retired_sessions.contains(&(
                                                    recovery_binding.owner.clone(),
                                                    recovery_binding.parent_session.clone(),
                                                ))
                                                || state
                                                    .children
                                                    .contains_key(&recovery_binding.operation_id)
                                                || !state.startup_pending.contains(&(
                                                    recovery_binding.owner.clone(),
                                                    recovery_binding.operation_id,
                                                ))
                                            {
                                                return Err(crate::ApiError::internal(
                                                    "Delegation recovery is fenced",
                                                ));
                                            }
                                            Ok(state)
                                        },
                                    )
                                    .map_err(|error| error.message)
                                })
                                .await
                                .map_err(|_| "Delegated task recovery is unconfirmed".to_string())?
                            },
                        )
                        .await;
                    match outcome {
                        Ok(Some(_)) => {
                            self.state
                                .lock()
                                .map_err(|_| "Delegation supervisor unavailable")?
                                .startup_pending
                                .remove(&(owner.into(), binding.operation_id));
                        }
                        Ok(None) => continue,
                        Err(_) => {
                            tracing::warn!("An unfinished delegated task could not be reconciled; its record was retained");
                            continue;
                        }
                    }
                }
                match self
                    .outbox
                    .stage_persisted_task_result(owner, binding.operation_id, 0)
                    .await
                {
                    Ok(Some(_)) => {}
                    Ok(None) => continue,
                    Err(_) => {
                        tracing::warn!(
                            "A delegated task outcome could not be staged; its record was retained"
                        );
                        continue;
                    }
                }
            }
            let mut attempt = 0;
            let result = loop {
                let result =
                    self.outbox
                        .deliver_bound_parent_with_guard(
                            manager,
                            owner,
                            binding.operation_id,
                            || {
                                let state = self
                                    .state
                                    .lock()
                                    .map_err(|_| "Delegation supervisor unavailable")?;
                                if state.closing
                                    || state.fenced_owners.contains(owner)
                                    || state
                                        .retired_sessions
                                        .contains(&(owner.into(), binding.parent_session.clone()))
                                    || state.children.get(&binding.operation_id).is_some_and(
                                        |child| {
                                            // A child whose supervisor finished cleanly no longer
                                            // delivers; its staged result must be recoverable in
                                            // this process, e.g. after logout and sign-in.
                                            !matches!(&*child.completion.borrow(), Some(Ok(())))
                                        },
                                    )
                                {
                                    return Err("Delegation recovery is fenced".into());
                                }
                                Ok(state)
                            },
                            |queue, scope, identity, mutation| {
                                submit_bound_delegation(
                                    manager, &binding, queue, scope, identity, mutation,
                                )
                            },
                        )
                        .await;
                attempt += 1;
                match &result {
                    Err(error) if attempt < 4 && error.contains("busy") => {
                        tokio::time::sleep(std::time::Duration::from_millis(250 << attempt)).await;
                    }
                    _ => break result,
                }
            };
            if result.is_err() {
                tracing::warn!(
                    "A delegated result could not be reconciled; its record was retained"
                );
            }
        }
        Ok(())
    }

    fn start(
        self: &Arc<Self>,
        manager: crate::structured::StructuredSessionManager,
        binding: Binding,
        child: AuthorizedHeldChild,
        cancel: super::interaction::Cancellation,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<crate::workspace_tasks::TaskRecord>>> {
        if !manager.has_delegation_supervisor(self)
            || child.approved.binding() != &binding
            || Path::new(&binding.data_root) != self.outbox.data_root
        {
            return Err("Delegation scope changed".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Delegation supervisor unavailable")?;
        state
            .children
            .retain(|_, child| !matches!(&*child.completion.borrow(), Some(Ok(()))));
        if state.closing
            || state.fenced_owners.contains(&binding.owner)
            || state
                .retired_sessions
                .contains(&(binding.owner.clone(), binding.parent_session.clone()))
        {
            return Err("Conversation is retiring or the server is shutting down".into());
        }
        if state.children.len() >= MAX_RECORDS as usize
            || state.children.contains_key(&binding.operation_id)
            || state
                .startup_pending
                .contains(&(binding.owner.clone(), binding.operation_id))
        {
            return Err("Delegation supervisor capacity or identity conflict".into());
        }
        let shutdown = super::interaction::Cancellation::default();
        let (started, handle) = Arc::clone(&self.outbox).spawn_and_deliver(
            manager,
            binding.clone(),
            child,
            cancel,
            shutdown.clone(),
        );
        let (sender, completion) = tokio::sync::watch::channel(None);
        let outbox = Arc::clone(&self.outbox);
        let owner = binding.owner.clone();
        let operation = binding.operation_id;
        tokio::spawn(async move {
            let result = match handle.await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => match outbox.read(&owner, operation) {
                    Ok(Some(record)) if record.terminal.is_some() => Ok(()),
                    _ => Err(error),
                },
                Err(_) => Err("Delegated child supervisor stopped unexpectedly".into()),
            };
            sender.send_replace(Some(result));
        });
        state.children.insert(
            binding.operation_id,
            SupervisedChild {
                owner: binding.owner,
                parent: binding.parent_session,
                shutdown,
                completion,
            },
        );
        Ok(started)
    }

    async fn wait_children(
        children: Vec<(
            super::interaction::Cancellation,
            tokio::sync::watch::Receiver<Option<Result<()>>>,
        )>,
    ) -> Result<()> {
        for (shutdown, _) in &children {
            shutdown.cancel();
        }
        for (_, mut child) in children {
            loop {
                if let Some(result) = child.borrow().clone() {
                    result?;
                    break;
                }
                child
                    .changed()
                    .await
                    .map_err(|_| "Delegated child cleanup is unconfirmed")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn retire_session(&self, owner: &str, parent: &str) -> Result<()> {
        let children = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            state.retired_sessions.insert((owner.into(), parent.into()));
            state
                .children
                .values()
                .filter(|child| child.owner == owner && child.parent == parent)
                .map(|child| (child.shutdown.clone(), child.completion.clone()))
                .collect()
        };
        Self::wait_children(children).await
    }

    pub(crate) fn release_retired_session(&self, owner: &str, parent: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .retired_sessions
                .remove(&(owner.into(), parent.into()));
        }
    }

    pub(crate) async fn stop_owner(&self, owner: &str) -> Result<()> {
        let children = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            state.fenced_owners.insert(owner.into());
            state
                .children
                .values()
                .filter(|child| child.owner == owner)
                .map(|child| (child.shutdown.clone(), child.completion.clone()))
                .collect()
        };
        Self::wait_children(children).await
    }

    pub(crate) fn resume_owner(&self, owner: &str) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Delegation supervisor unavailable")?;
        if state.cleanup_requests.contains_key(owner) {
            return Err("Owner cleanup receipt has not been released".into());
        }
        if !state.closing {
            state.fenced_owners.remove(owner);
        }
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        let children = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            state.closing = true;
            state
                .children
                .values()
                .map(|child| (child.shutdown.clone(), child.completion.clone()))
                .collect()
        };
        Self::wait_children(children).await
    }
}

/// This only gates launch. The caller must retain and supervise the returned
/// process and fence the parent lifecycle independently.
struct AuthorizedHeldChild {
    command: tokio::process::Command,
    approved: super::delegation_review::ApprovedDelegation,
    data_root: PathBuf,
}

impl AuthorizedHeldChild {
    fn launch(self) -> Result<tokio::process::Child> {
        let Self {
            mut command,
            approved,
            data_root,
        } = self;
        approved.admit_launch(|| {
            let binding = approved.binding();
            if !data_root.is_dir()
                || !Path::new(&binding.workspace).is_dir()
                || data_root.canonicalize().ok().as_deref() != Some(data_root.as_path())
                || Path::new(&binding.workspace).canonicalize().ok().as_deref()
                    != Some(Path::new(&binding.workspace))
            {
                return Err("Delegation scope changed".into());
            }
            approved.check_expiry()?;
            command
                .spawn()
                .map_err(|_| "Cannot start delegated child".into())
        })
    }
}
type Result<T> = std::result::Result<T, String>;

fn valid_identity(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}

#[cfg(unix)]
fn paired_attestation_binding(binding: &Binding) -> Result<Vec<u8>> {
    let mut reviewed = binding.clone();
    reviewed.paired_attestation = None;
    serde_json::to_vec(&reviewed).map_err(|_| "Cannot encode reviewed delegation".into())
}

#[cfg(unix)]
fn submit_bound_delegation(
    manager: &crate::structured::StructuredSessionManager,
    binding: &Binding,
    queue: &crate::followup_queue::QueueStore,
    scope: &crate::followup_queue::QueueScope,
    identity: Uuid,
    mutation: Mutation,
) -> Result<MutationReceipt> {
    if let (Some(grant), Some(proof)) = (&binding.paired_authorization, &binding.paired_attestation)
    {
        let incarnation = binding
            .parent_incarnation
            .ok_or("Delegation parent identity is unavailable")?;
        let reviewed_binding = paired_attestation_binding(binding)?;
        return manager.with_delegation_paired_authority(&binding.owner, grant, |check| {
            check()?;
            queue
                .verify_paired_delegation_binding(&binding.owner, grant, &reviewed_binding, proof)
                .map_err(|error| format!("{error:?}"))?;
            check()?;
            queue
                .mutate_existing_paired_with_identity(
                    scope,
                    identity,
                    incarnation,
                    mutation,
                    grant,
                    check,
                )
                .map_err(|error| format!("{error:?}"))
        });
    }
    let Some(claims) = &binding.authorization else {
        // Without a local credential, the queue stores no dispatch proof. The
        // queue dispatcher must hold this item for explicit review.
        return queue
            .mutate_existing_held_with_identity(scope, identity, mutation)
            .map_err(|error| format!("{error:?}"));
    };
    let authority = crate::auth::LocalAuthority::from_persisted_queue_claims(
        &binding.owner,
        claims.generation,
        claims.expires_at_ms,
    )?;
    manager.with_delegation_local_authority(
        &binding.owner,
        &authority,
        "Queue publication outcome is uncertain; reconcile its operation receipt",
        |check| {
            queue
                .mutate_existing_authorized_with_identity(
                    scope,
                    identity,
                    claims.session_incarnation,
                    mutation,
                    &authority,
                    check,
                )
                .map_err(|error| format!("{error:?}"))
        },
    )
}

#[cfg(not(unix))]
fn submit_bound_delegation(
    _manager: &crate::structured::StructuredSessionManager,
    _binding: &Binding,
    _queue: &crate::followup_queue::QueueStore,
    _scope: &crate::followup_queue::QueueScope,
    _identity: Uuid,
    _mutation: Mutation,
) -> Result<MutationReceipt> {
    Err("Delegated queue admission is unavailable on this platform".into())
}
pub(super) fn validate_binding(b: &Binding) -> Result<()> {
    #[cfg(unix)]
    if b.paired_authorization.as_ref().is_some_and(|grant| {
        b.authorization.is_some()
            || b.parent_incarnation.is_none()
            || !grant.valid_binding_for(&b.owner)
    }) {
        return Err("Invalid delegation binding".into());
    }
    #[cfg(unix)]
    if b.paired_attestation.is_some() && b.paired_authorization.is_none() {
        return Err("Invalid delegation binding".into());
    }
    if ![
        &b.owner,
        &b.parent_session,
        &b.parent_turn,
        &b.child_session,
        &b.task,
        &b.provider,
        &b.model,
    ]
    .iter()
    .all(|s| valid_identity(s))
        || b.workspace.len() > MAX_WORKSPACE_BYTES
        || b.workspace.chars().any(char::is_control)
        || !Path::new(&b.workspace).is_absolute()
        || b.data_root.len() > MAX_WORKSPACE_BYTES
        || b.data_root.chars().any(char::is_control)
        || !Path::new(&b.data_root).is_absolute()
        || b.prompt.trim().is_empty()
        || b.prompt.contains('\0')
        || b.prompt.len() > MAX_PROMPT_BYTES
        || b.prompt.chars().count() > 50_000
        || b.operation_id.is_nil()
        || b.queue_identity.is_nil()
        || b.parent_incarnation
            .is_some_and(|incarnation| incarnation.is_nil())
        || b.authorization.as_ref().is_some_and(|authorization| {
            authorization.session_incarnation.is_nil()
                || b.parent_incarnation != Some(authorization.session_incarnation)
                || authorization.generation < 0
                || authorization.expires_at_ms <= 0
        })
    {
        return Err("Invalid delegation binding".into());
    }
    Ok(())
}
fn validate_terminal(b: &Binding, t: &Terminal) -> Result<()> {
    if t.result.len() > MAX_RESULT_BYTES
        || t.mutation.operation_id != b.operation_id
        || t.mutation.expected_queue_revision == u64::MAX
        || t.source_digest.as_ref().is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err("Invalid delegation result or operation identity".into());
    }
    match &t.mutation.operation {
        QueueOperation::Enqueue {
            item_id,
            text,
            run_when_idle: false,
        } if !item_id.is_nil()
            && !text.trim().is_empty()
            && !text.contains('\0')
            && text.len() <= MAX_QUEUE_TEXT_BYTES
            && text.chars().count() <= 50_000 =>
        {
            Ok(())
        }
        _ => Err("Delegation delivery must be a bounded enqueue without automatic resume".into()),
    }
}

fn terminal_from_task(
    binding: &Binding,
    task: &crate::workspace_tasks::TaskRecord,
    queue_revision: u64,
) -> Result<Terminal> {
    use crate::workspace_tasks::TaskStatus;
    validate_binding(binding)?;
    let expected = binding.task_input();
    if task.id.to_string() != binding.task
        || task.child_session_id.map(|id| id.to_string()).as_deref()
            != Some(binding.child_session.as_str())
        || task.input.workspace_path != expected.workspace_path
        || task.input.provider != expected.provider
        || task.input.prompt != expected.prompt
        || task.input.model != expected.model
        || task.input.parent_session_id != expected.parent_session_id
        || task.input.parent_task_id.is_some()
        || task.schedule_id.is_some()
        || task.completed_at.is_none()
        || task.result.len() > MAX_RESULT_BYTES
    {
        return Err("Delegated task does not match its admission".into());
    }
    let (outcome, label) = match &task.status {
        TaskStatus::Completed => (Outcome::Succeeded, "completed"),
        TaskStatus::Failed => (Outcome::Failed, "failed"),
        TaskStatus::Cancelled => (Outcome::Cancelled, "cancelled"),
        TaskStatus::Interrupted => (Outcome::Interrupted, "interrupted"),
        _ => return Err("Delegated task has not reached a terminal state".into()),
    };
    let source = match &task.status {
        TaskStatus::Completed | TaskStatus::Failed => task.result.as_str(),
        _ => "",
    };
    if source.len() > MAX_RESULT_BYTES {
        return Err("Delegated task result exceeds its limit".into());
    }
    let result = displayed_result(
        source,
        matches!(&task.status, TaskStatus::Completed | TaskStatus::Failed) && task.output_truncated,
    );
    let terminal = Terminal {
        outcome,
        mutation: Mutation {
            operation_id: binding.operation_id,
            expected_queue_revision: queue_revision,
            operation: QueueOperation::Enqueue {
                item_id: binding.operation_id,
                text: format!("Delegated task {} ({label}):\n{result}", binding.task),
                run_when_idle: false,
            },
        },
        result,
        source_digest: match &task.status {
            TaskStatus::Completed | TaskStatus::Failed => Some(result_digest(&task.result)),
            _ => None,
        },
    };
    validate_terminal(binding, &terminal)?;
    Ok(terminal)
}

fn validate_staged_terminal(record: &Record, terminal: &Terminal) -> Result<()> {
    let label = match &terminal.outcome {
        Outcome::Succeeded | Outcome::Failed => {
            let proof = record
                .child_proof
                .as_ref()
                .ok_or("Delegated child result was not verified")?;
            let is_error = terminal.outcome == Outcome::Failed;
            if proof.is_error != is_error
                || terminal.source_digest.as_deref() != Some(proof.result_sha256.as_str())
                || ![&proof.displayed_sha256, &proof.displayed_truncated_sha256]
                    .contains(&&result_digest(&terminal.result))
            {
                return Err("Delegated child result does not match its receipt".into());
            }
            if is_error {
                "failed"
            } else {
                "completed"
            }
        }
        Outcome::Cancelled => "cancelled",
        Outcome::Interrupted => "interrupted",
    };
    if matches!(&terminal.outcome, Outcome::Cancelled | Outcome::Interrupted)
        && (terminal.source_digest.is_some() || terminal.result != "No answer was returned.")
    {
        return Err("Unverified partial child output cannot be delivered".into());
    }
    match &terminal.mutation.operation {
        QueueOperation::Enqueue {
            item_id,
            text,
            run_when_idle: false,
        } if *item_id == record.binding.operation_id
            && *text
                == format!(
                    "Delegated task {} ({label}):\n{}",
                    record.binding.task, terminal.result
                ) =>
        {
            Ok(())
        }
        _ => Err("Delegated task delivery does not match its receipt".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct VerifiedChildResult {
    text: String,
    is_error: bool,
}

fn verify_child_output(
    binding: &Binding,
    stdout: &[u8],
    truncated: bool,
    exit_code: Option<i32>,
) -> Result<VerifiedChildResult> {
    #[derive(Deserialize)]
    #[serde(tag = "type", deny_unknown_fields)]
    enum ChildEvent {
        #[serde(rename = "v4.text.delta")]
        Delta {
            #[serde(rename = "sessionId")]
            session_id: String,
            delta: String,
        },
        #[serde(rename = "v4.result")]
        Result {
            #[serde(rename = "sessionId")]
            session_id: String,
            text: String,
            is_error: bool,
        },
    }

    validate_binding(binding)?;
    let id = Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid child session")?;
    if id.is_nil() || id.to_string() != binding.child_session {
        return Err("Invalid child session".into());
    }
    if truncated || stdout.len() > 256 * 1024 || !stdout.ends_with(b"\n") {
        return Err("Delegated child output is incomplete".into());
    }
    let output = std::str::from_utf8(stdout).map_err(|_| "Invalid delegated child output")?;
    let mut result = None;
    for line in output.strip_suffix('\n').unwrap().split('\n') {
        if line.is_empty() || result.is_some() {
            return Err("Invalid delegated child output".into());
        }
        let event: ChildEvent =
            serde_json::from_str(line).map_err(|_| "Invalid delegated child output")?;
        match event {
            ChildEvent::Delta { session_id, delta } => {
                if session_id != binding.child_session || delta.len() > MAX_RESULT_BYTES {
                    return Err(
                        "Delegated child output has the wrong scope or exceeds its limit".into(),
                    );
                }
            }
            ChildEvent::Result {
                session_id,
                text,
                is_error,
            } => {
                if session_id != binding.child_session || text.len() > MAX_RESULT_BYTES {
                    return Err(
                        "Delegated child output has the wrong scope or exceeds its limit".into(),
                    );
                }
                result = Some(VerifiedChildResult { text, is_error });
            }
        }
    }
    let result = result.ok_or("Delegated child did not produce a complete result")?;
    if exit_code != Some(if result.is_error { 1 } else { 0 }) {
        return Err("Delegated child exit does not match its result".into());
    }
    Ok(result)
}
fn validate_receipt(t: &Terminal, r: &MutationReceipt) -> Result<()> {
    let QueueOperation::Enqueue { item_id, .. } = &t.mutation.operation else {
        return Err("Invalid stored operation".into());
    };
    if r.operation_id != t.mutation.operation_id
        || r.item_id != Some(*item_id)
        || r.item_revision != Some(1)
        || r.queue_revision
            != t.mutation
                .expected_queue_revision
                .checked_add(1)
                .unwrap_or(0)
    {
        return Err("Queue receipt does not match the stored operation".into());
    }
    Ok(())
}
/// True only for the queue's own pre-mutation lock failures. Neither can occur
/// after the queue applied a mutation, so such a submission was never applied.
fn is_unapplied_busy(error: &str) -> bool {
    error == "Unavailable(\"Queue storage is busy; retry\")"
        || error == "Unavailable(\"Queue storage is busy or unavailable\")"
}

/// Failures after which another delivery pass is safe: it either reconciles an
/// applied mutation by its receipt or refuses to replay an uncertain attempt.
fn is_transient_delivery_error(error: &str) -> bool {
    error.contains("busy") || error.contains("unavailable") || error.contains("uncertain")
}

fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| "Cannot encode outbox record".into())
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| "Corrupt outbox record".into())
}

impl Outbox {
    /// The guard persists independently of the ledger. An incomplete guard,
    /// missing ledger, or changed file identity is never treated as a new install.
    #[cfg(unix)]
    pub(super) fn open_or_provision(data: &Path) -> Result<Self> {
        Self::open_provisioned(data, true)
    }

    #[cfg(unix)]
    fn open_existing(data: &Path) -> Result<Self> {
        Self::open_provisioned(data, false)
    }

    #[cfg(unix)]
    fn open_provisioned(data: &Path, create: bool) -> Result<Self> {
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        if !data.is_absolute() || data.canonicalize().ok().as_deref() != Some(data) {
            return Err("Outbox data directory must be canonical".into());
        }
        let path = data.join("delegation-outbox");
        let guard_path = data.join("delegation-outbox.guard");
        check_parent(&path)?;
        match std::fs::symlink_metadata(&guard_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {}
                    _ => return Err("Outbox guard is missing; recovery is required".into()),
                }
            }
            Ok(_) => {}
            Err(_) => return Err("Outbox guard is unavailable".into()),
        }
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let (mut guard, created) = if !create {
            (
                options
                    .open(&guard_path)
                    .map_err(|_| "Outbox guard is unavailable")?,
                false,
            )
        } else {
            match options.create_new(true).open(&guard_path) {
                Ok(file) => (file, true),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let file = std::fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                        .open(&guard_path)
                        .map_err(|_| "Outbox guard is unavailable")?;
                    (file, false)
                }
                Err(_) => return Err("Cannot create outbox guard".into()),
            }
        };
        lock_file(&guard)?;
        check_file(&guard_path)?;
        let opened = guard
            .metadata()
            .map_err(|_| "Outbox guard is unavailable")?;
        let current =
            std::fs::symlink_metadata(&guard_path).map_err(|_| "Outbox guard is unavailable")?;
        if (opened.dev(), opened.ino()) != (current.dev(), current.ino()) || opened.len() > 4096 {
            return Err("Outbox guard changed or is invalid".into());
        }
        if created {
            guard
                .write_all(b"initializing\n")
                .and_then(|_| guard.sync_all())
                .map_err(|_| "Cannot persist outbox initialization")?;
            File::open(data)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Cannot sync outbox guard")?;
            let mut outbox = Self::create(&path)?;
            let identity = outbox_identity(&path)?;
            let bytes =
                serde_json::to_vec(&identity).map_err(|_| "Cannot encode outbox identity")?;
            guard
                .set_len(0)
                .and_then(|_| guard.seek(SeekFrom::Start(0)).map(|_| ()))
                .and_then(|_| guard.write_all(&bytes))
                .and_then(|_| guard.sync_all())
                .map_err(|_| "Cannot persist outbox identity")?;
            outbox._provision_guard = Some(guard);
            Ok(outbox)
        } else {
            let mut bytes = Vec::new();
            guard
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read outbox guard")?;
            let expected: OutboxIdentity = serde_json::from_slice(&bytes)
                .map_err(|_| "Outbox initialization is incomplete; recovery is required")?;
            if expected.version != 1 {
                return Err("Unsupported outbox identity".into());
            }
            if outbox_identity(&path)? != expected {
                return Err("Outbox identity changed; recovery is required".into());
            }
            let mut outbox = Self::open(&path)?;
            if outbox_identity(&path)? != expected {
                return Err("Outbox identity changed; recovery is required".into());
            }
            outbox._provision_guard = Some(guard);
            Ok(outbox)
        }
    }

    /// Initialize a new private directory only. A failed initialization must be
    /// investigated; callers must not silently discard or replace partial state.
    #[cfg(unix)]
    pub(super) fn create(path: &Path) -> Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        check_parent(path)?;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| "Cannot create outbox directory")?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("owner.lock"))
            .map_err(|_| "Cannot create outbox lock")?;
        lock_file(&lock)?;
        let dbfile = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("outbox.sqlite3"))
            .map_err(|_| "Cannot create outbox database")?;
        dbfile
            .sync_all()
            .map_err(|_| "Cannot sync outbox database")?;
        let db = Connection::open_with_flags(
            path.join("outbox.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|_| "Cannot open outbox database")?;
        limit_database(&db)?;
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE records (owner TEXT NOT NULL, operation_id TEXT NOT NULL, child TEXT NOT NULL, task TEXT NOT NULL, binding TEXT NOT NULL, terminal TEXT, receipt TEXT, child_proof TEXT, delivery_attempted INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempted IN (0, 1)), PRIMARY KEY(owner, operation_id), UNIQUE(owner, child), UNIQUE(owner, task)); PRAGMA user_version=6; COMMIT;").map_err(|_| "Cannot initialize outbox database")?;
        db.execute_batch(prune::SCHEMA)
            .map_err(|_| "Cannot initialize outbox database")?;
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync outbox directory")?;
        File::open(path.parent().ok_or("Missing outbox parent")?)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync outbox parent")?;
        Ok(Self {
            db: Mutex::new(db),
            data_root: path
                .parent()
                .ok_or("Missing outbox parent")?
                .canonicalize()
                .map_err(|_| "Cannot resolve outbox parent")?,
            _lock: lock,
            _provision_guard: None,
        })
    }
    /// Open an existing initialized ledger, including SQLite's hot-journal recovery.
    #[cfg(unix)]
    pub(super) fn open(path: &Path) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        check_parent(path)?;
        check_directory(path, true)?;
        for name in [
            "owner.lock",
            "outbox.sqlite3",
            "outbox.sqlite3-journal",
            "outbox.sqlite3-wal",
            "outbox.sqlite3-shm",
        ] {
            let p = path.join(name);
            match std::fs::symlink_metadata(&p) {
                Ok(_) => check_file(&p)?,
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        && name != "owner.lock"
                        && name != "outbox.sqlite3" => {}
                Err(_) => return Err("Missing or inaccessible outbox file".into()),
            }
        }
        // WAL is never used here; do not attempt a different recovery protocol.
        if path.join("outbox.sqlite3-wal").exists() || path.join("outbox.sqlite3-shm").exists() {
            return Err("Unexpected outbox WAL files".into());
        }
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("owner.lock"))
            .map_err(|_| "Cannot open outbox lock")?;
        lock_file(&lock)?;
        let db = Connection::open_with_flags(
            path.join("outbox.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(|_| "Cannot open outbox database")?;
        limit_database(&db)?;
        db.execute_batch("PRAGMA synchronous=FULL;")
            .map_err(|_| "Cannot configure outbox database")?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| "Cannot inspect outbox version")?;
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|_| "Cannot inspect outbox integrity")?;
        if version != 6 || integrity != "ok" {
            return Err("Outbox database is incomplete or corrupt".into());
        }
        db.execute_batch(prune::SCHEMA)
            .map_err(|_| "Cannot upgrade outbox database")?;
        let count: i64 = db
            .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
            .map_err(|_| "Invalid outbox schema")?;
        if count > MAX_RECORDS || prune::tombstone_count(&db)? > prune::MAX_TOMBSTONES {
            return Err("Outbox record capacity exceeded".into());
        }
        let invalid_attempts: i64 = db.query_row("SELECT count(*) FROM records WHERE delivery_attempted NOT IN (0, 1) OR delivery_attempted IS NULL OR (delivery_attempted = 1 AND terminal IS NULL)", [], |row| row.get(0)).map_err(|_| "Invalid outbox schema")?;
        if invalid_attempts != 0 {
            return Err("Invalid outbox delivery state".into());
        }
        {
            let mut stmt = db.prepare("SELECT owner, operation_id, child, task, binding, terminal, receipt, child_proof FROM records").map_err(|_| "Invalid outbox schema")?;
            let mut rows = stmt
                .query([])
                .map_err(|_| "Cannot inspect outbox records")?;
            while let Some(row) = rows.next().map_err(|_| "Cannot inspect outbox records")? {
                let owner: String = row.get(0).map_err(|_| "Corrupt outbox record")?;
                let op: String = row.get(1).map_err(|_| "Corrupt outbox record")?;
                let child: String = row.get(2).map_err(|_| "Corrupt outbox record")?;
                let task: String = row.get(3).map_err(|_| "Corrupt outbox record")?;
                let record = parse_record(
                    row.get(4).map_err(|_| "Corrupt outbox record")?,
                    row.get(5).map_err(|_| "Corrupt outbox record")?,
                    row.get(6).map_err(|_| "Corrupt outbox record")?,
                    row.get(7).map_err(|_| "Corrupt outbox record")?,
                )?;
                if record.binding.owner != owner
                    || record.binding.operation_id.to_string() != op
                    || record.binding.child_session != child
                    || record.binding.task != task
                {
                    return Err("Inconsistent outbox index".into());
                }
            }
        }
        Ok(Self {
            db: Mutex::new(db),
            data_root: path
                .parent()
                .ok_or("Missing outbox parent")?
                .canonicalize()
                .map_err(|_| "Cannot resolve outbox parent")?,
            _lock: lock,
            _provision_guard: None,
        })
    }
    #[cfg(not(unix))]
    pub(super) fn create(_path: &Path) -> Result<Self> {
        Err("Outbox unavailable on this platform".into())
    }
    #[cfg(not(unix))]
    pub(super) fn open(_path: &Path) -> Result<Self> {
        Err("Outbox unavailable on this platform".into())
    }

    pub(super) fn admit(&self, b: &Binding) -> Result<Admission> {
        self.admit_checked(b, || Ok(()))
    }

    fn admit_checked(&self, b: &Binding, check: impl Fn() -> Result<()>) -> Result<Admission> {
        validate_binding(b)?;
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin outbox admission")?;
        check()?;
        if let Some(record) = read_record(&tx, &b.owner, b.operation_id)? {
            return if record.binding == *b {
                Ok(Admission::Existing)
            } else {
                Err("Delegation binding conflict".into())
            };
        }
        if let Some(admission) = prune::replayed(&tx, b)? {
            return Ok(admission);
        }
        let mut count: i64 = tx
            .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
            .map_err(|_| "Cannot check outbox capacity")?;
        if count >= MAX_RECORDS {
            count -= prune::prune_delivered(&tx)?;
        }
        if count >= MAX_RECORDS {
            return Err("Outbox capacity exhausted; undelivered results retained".into());
        }
        tx.execute(
            "INSERT INTO records(owner,operation_id,child,task,binding) VALUES(?1,?2,?3,?4,?5)",
            params![
                b.owner,
                b.operation_id.to_string(),
                b.child_session,
                b.task,
                encode(b)?
            ],
        )
        .map_err(|_| "Delegation identity already used or outbox unavailable")?;
        check()?;
        tx.commit().map_err(|_| "Cannot commit outbox admission")?;
        Ok(Admission::New)
    }

    /// Caller must authenticate, approve and fence the parent before admission.
    /// An existing admission is deliberately never turned into another launch.
    #[cfg(test)]
    fn prepare_read_only_child(&self, data: &Path, b: &Binding) -> Result<tokio::process::Command> {
        self.prepare_read_only_child_checked(data, b, || Ok(()))
    }

    fn prepare_read_only_child_checked(
        &self,
        data: &Path,
        b: &Binding,
        check: impl Fn() -> Result<()>,
    ) -> Result<tokio::process::Command> {
        if Path::new(&b.data_root) != self.data_root
            || data
                .canonicalize()
                .map_err(|_| "Data directory unavailable")?
                != self.data_root
        {
            return Err("Delegation data scope changed".into());
        }
        #[cfg(unix)]
        if let Some(proof) = &b.paired_attestation {
            let grant = b
                .paired_authorization
                .as_ref()
                .ok_or("Paired grant is unavailable")?;
            let queue = crate::followup_queue::QueueStore::new(
                &self.data_root,
                crate::structured::queue::boot_id(),
            )
            .fail_fast();
            queue
                .verify_paired_delegation_binding(
                    &b.owner,
                    grant,
                    &paired_attestation_binding(b)?,
                    proof,
                )
                .map_err(|error| format!("{error:?}"))?;
        }
        let parent = b
            .parent_session
            .strip_prefix("ss-")
            .ok_or("Invalid parent session")?;
        let parent_id = Uuid::parse_str(parent).map_err(|_| "Invalid parent session")?;
        let child_id = Uuid::parse_str(&b.child_session).map_err(|_| "Invalid child session")?;
        let task_id = Uuid::parse_str(&b.task).map_err(|_| "Invalid task ID")?;
        if parent_id.is_nil()
            || parent != parent_id.simple().to_string()
            || child_id.is_nil()
            || child_id.to_string() != b.child_session
            || task_id.is_nil()
            || task_id.to_string() != b.task
        {
            return Err("Invalid delegation identities".into());
        }
        let workspace = Path::new(&b.workspace);
        if !workspace.is_absolute()
            || workspace
                .canonicalize()
                .map_err(|_| "Workspace unavailable")?
                != workspace
            || !workspace.is_dir()
        {
            return Err("Workspace scope changed".into());
        }
        let command = super::read_only_child_command(
            &self.data_root,
            &b.owner,
            &b.provider,
            &b.prompt,
            Some(&b.model),
            workspace,
            child_id,
        )?;
        match self.admit_checked(b, check)? {
            Admission::New => Ok(command),
            Admission::Existing => Err("Child admission already exists; do not replay".into()),
        }
    }

    /// The task remains held: an integrating supervisor must independently
    /// authenticate and approve the parent, and own launch and recovery.
    #[cfg(test)]
    async fn prepare_held_child(
        &self,
        data: &Path,
        binding: &Binding,
    ) -> Result<(crate::workspace_tasks::TaskRecord, tokio::process::Command)> {
        self.prepare_held_child_checked(data, binding, || Ok(()))
            .await
    }

    async fn prepare_held_child_checked(
        &self,
        data: &Path,
        binding: &Binding,
        check: impl Fn() -> Result<()>,
    ) -> Result<(crate::workspace_tasks::TaskRecord, tokio::process::Command)> {
        let command = self.prepare_read_only_child_checked(data, binding, &check)?;
        check()?;
        let task = crate::workspace_tasks::admit_held_delegation(
            self.data_root.clone(),
            binding.owner.clone(),
            binding.task_input(),
            Uuid::parse_str(&binding.task).map_err(|_| "Invalid task ID")?,
            Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid child session ID")?,
        )
        .await
        .map_err(|error| error.message)?;
        check().map_err(|_| {
            "Delegation was admitted but remains held; execution was not started".to_string()
        })?;
        Ok((task, command))
    }

    #[cfg(test)]
    pub(super) async fn prepare_reviewed_held_child(
        &self,
        data: &Path,
        approved: super::delegation_review::ApprovedDelegation,
    ) -> Result<(crate::workspace_tasks::TaskRecord, tokio::process::Command)> {
        let binding = approved.binding();
        self.prepare_held_child_checked(data, binding, || {
            approved.check()?;
            if Path::new(&binding.workspace).canonicalize().ok().as_deref()
                != Some(Path::new(&binding.workspace))
                || data.canonicalize().ok().as_deref() != Some(Path::new(&binding.data_root))
            {
                return Err("Delegation scope changed".into());
            }
            Ok(())
        })
        .await
    }

    async fn prepare_authorized_held_child(
        &self,
        data: &Path,
        approved: super::delegation_review::ApprovedDelegation,
    ) -> Result<(crate::workspace_tasks::TaskRecord, AuthorizedHeldChild)> {
        let binding = approved.binding();
        let (task, command) = self
            .prepare_held_child_checked(data, binding, || {
                approved.check()?;
                if Path::new(&binding.workspace).canonicalize().ok().as_deref()
                    != Some(Path::new(&binding.workspace))
                    || data.canonicalize().ok().as_deref() != Some(Path::new(&binding.data_root))
                {
                    return Err("Delegation scope changed".into());
                }
                Ok(())
            })
            .await?;
        Ok((
            task,
            AuthorizedHeldChild {
                command,
                approved,
                data_root: self.data_root.clone(),
            },
        ))
    }

    async fn launch_prepared_held_child(
        &self,
        binding: &Binding,
        mut child: AuthorizedHeldChild,
        shutdown: &super::interaction::Cancellation,
        manager: Option<crate::structured::StructuredSessionManager>,
    ) -> Result<(crate::workspace_tasks::TaskRecord, tokio::process::Child)> {
        if child.approved.binding() != binding || Path::new(&binding.data_root) != self.data_root {
            return Err("Delegation binding changed".into());
        }
        super::delegation_lifeline::arm(child.command.as_std_mut());
        child
            .command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        child.command.process_group(0);
        let runtime = tokio::runtime::Handle::current();
        let shutdown = shutdown.clone();
        #[cfg(unix)]
        let paired = binding.paired_authorization.clone();
        #[cfg(unix)]
        if paired.is_some() && binding.paired_attestation.is_none() {
            return Err("Paired delegation authority is not protected".into());
        }
        let owner = binding.owner.clone();
        crate::workspace_tasks::launch_held_delegation(
            self.data_root.clone(),
            binding.owner.clone(),
            Uuid::parse_str(&binding.task).map_err(|_| "Invalid task ID")?,
            Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid child session")?,
            binding.task_input(),
            move || {
                let _runtime = runtime.enter();
                shutdown
                    .admit(|| {
                        #[cfg(unix)]
                        if let Some(grant) = &paired {
                            let manager = manager
                                .as_ref()
                                .ok_or("Paired launch authority unavailable")?;
                            return manager.launch_with_delegation_paired_authority(
                                &owner,
                                grant,
                                |check| {
                                    check()?;
                                    child.launch()
                                },
                            );
                        }
                        let _ = (manager, owner);
                        child.launch()
                    })
                    .map_err(crate::ApiError::internal)
            },
        )
        .await
        .map_err(|error| error.message)
    }

    /// The caller must retain the supervisor handle through shutdown. Losing
    /// the start receipt never abandons or silently repeats an approved child.
    #[cfg(test)]
    fn spawn_prepared_held_child(
        self: Arc<Self>,
        binding: Binding,
        child: AuthorizedHeldChild,
        cancel: super::interaction::Cancellation,
        shutdown: super::interaction::Cancellation,
    ) -> (
        tokio::sync::oneshot::Receiver<Result<crate::workspace_tasks::TaskRecord>>,
        tokio::task::JoinHandle<Result<crate::workspace_tasks::TaskRecord>>,
    ) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let (task, child) = match self
                .launch_prepared_held_child(&binding, child, &shutdown, None)
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    let _ = reply.send(Err(error.clone()));
                    return Err(error);
                }
            };
            let _ = reply.send(Ok(task));
            self.supervise_launched_child(&binding, child, &cancel, &shutdown)
                .await
        });
        (receiver, handle)
    }

    /// The caller retains this supervisor until shutdown and reconciles any
    /// durable task or queue receipt if delivery cannot be confirmed.
    #[cfg(unix)]
    fn spawn_and_deliver(
        self: Arc<Self>,
        manager: crate::structured::StructuredSessionManager,
        binding: Binding,
        child: AuthorizedHeldChild,
        cancel: super::interaction::Cancellation,
        shutdown: super::interaction::Cancellation,
    ) -> (
        tokio::sync::oneshot::Receiver<Result<crate::workspace_tasks::TaskRecord>>,
        tokio::task::JoinHandle<Result<crate::workspace_tasks::TaskRecord>>,
    ) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let (task, child) = match manager
                .with_bound_parent_launch(
                    &binding.owner,
                    &self.data_root,
                    &binding.parent_session,
                    Path::new(&binding.workspace),
                    binding.queue_identity,
                    binding.parent_incarnation,
                    &shutdown,
                    || {
                        self.launch_prepared_held_child(
                            &binding,
                            child,
                            &shutdown,
                            Some(manager.clone()),
                        )
                    },
                )
                .await
                .map_err(|error| error.message)
            {
                Ok(result) => result,
                Err(error) => {
                    let _ = reply.send(Err(error.clone()));
                    let task = crate::workspace_tasks::interrupt_unlaunched_delegation(
                        self.data_root.clone(),
                        binding.owner.clone(),
                        Uuid::parse_str(&binding.task).map_err(|_| "Invalid task ID")?,
                        Uuid::parse_str(&binding.child_session)
                            .map_err(|_| "Invalid child session")?,
                        binding.task_input(),
                    )
                    .await
                    .map_err(|failure| failure.message)?;
                    self.stage_persisted_task_result(&binding.owner, binding.operation_id, 0)
                        .await?
                        .ok_or("Delegated task outcome is unavailable")?;
                    if shutdown.is_cancelled() {
                        return Ok(task);
                    }
                    return Err(error);
                }
            };
            let _ = reply.send(Ok(task));
            let task = self
                .supervise_launched_child(&binding, child, &cancel, &shutdown)
                .await?;
            self.stage_persisted_task_result(&binding.owner, binding.operation_id, 0)
                .await?
                .ok_or("Delegated task outcome is unavailable")?;
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => Ok(task),
                delivery = self.deliver_bound_parent_with_retry(&manager, &binding.owner, binding.operation_id) => {
                    delivery?;
                    Ok(task)
                }
            }
        });
        (receiver, handle)
    }

    async fn supervise_launched_child(
        &self,
        binding: &Binding,
        mut child: tokio::process::Child,
        cancel: &super::interaction::Cancellation,
        shutdown: &super::interaction::Cancellation,
    ) -> Result<crate::workspace_tasks::TaskRecord> {
        use crate::workspace_tasks::TaskStatus;
        use std::{future::Future, pin::Pin, time::Duration};
        #[cfg(unix)]
        let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child)
            .map_err(|_| "Delegated child cleanup could not be confirmed")?;
        #[cfg(windows)]
        let tree = crate::process_tree::ProcessTree::attach(&child)
            .map_err(|_| "Delegated child cleanup could not be confirmed")?;
        let _lifeline = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or("Delegated child output unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Delegated child error stream unavailable")?;
        let mut stdout_reader = tokio::spawn(read_child_pipe(stdout, 256 * 1024));
        let mut stderr_reader = tokio::spawn(read_child_pipe(stderr, 0));
        let task_id = Uuid::parse_str(&binding.task).map_err(|_| "Invalid task ID")?;
        let child_id =
            Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid child session")?;
        type Probe =
            Pin<Box<dyn Future<Output = std::result::Result<TaskStatus, crate::ApiError>> + Send>>;
        let mut probe: Option<Probe> = None;
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let started = std::time::Instant::now();
        let mut forced = None;
        let mut status = None;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => { forced = Some(TaskStatus::Interrupted); break; }
                _ = cancel.cancelled() => { forced = Some(TaskStatus::Cancelled); break; }
                exit = tree.wait(&mut child) => { status = Some(exit); break; }
                outcome = async { probe.as_mut().expect("guarded probe").await }, if probe.is_some() => {
                    probe = None;
                    match outcome {
                        Ok(TaskStatus::Running) => {}
                        Ok(TaskStatus::Cancelling | TaskStatus::Cancelled) => { forced = Some(TaskStatus::Cancelled); break; }
                        _ => { forced = Some(TaskStatus::Interrupted); break; }
                    }
                }
                _ = interval.tick() => {
                    if started.elapsed() >= Duration::from_secs(1800) { forced = Some(TaskStatus::Interrupted); break; }
                    if probe.is_none() {
                        probe = Some(Box::pin(crate::workspace_tasks::delegated_task_status(
                            self.data_root.clone(), binding.owner.clone(), task_id, child_id, binding.task_input(),
                        )));
                    }
                }
            }
        }
        drop(probe);
        // Keep owning the child and process tree until cleanup is confirmed.
        while tree.stop(Duration::from_secs(3)).await.is_err() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if status.is_none() {
            status = Some(tree.wait(&mut child).await);
        }
        let stdout = match tokio::time::timeout(Duration::from_secs(2), &mut stdout_reader).await {
            Ok(Ok(Ok(value))) => Some(value),
            _ => {
                stdout_reader.abort();
                None
            }
        };
        if tokio::time::timeout(Duration::from_secs(2), &mut stderr_reader)
            .await
            .is_err()
        {
            stderr_reader.abort();
        }
        let exit_code = status
            .and_then(|value| value.ok())
            .and_then(|value| value.code());
        let (outcome, result) = if let Some(reason) = forced {
            (reason, String::new())
        } else if let Some((bytes, truncated)) = stdout {
            match verify_child_output(binding, &bytes, truncated, exit_code) {
                Ok(verified) => {
                    if self
                        .record_verified_child_output(
                            &binding.owner,
                            binding.operation_id,
                            &bytes,
                            truncated,
                            exit_code,
                        )
                        .is_ok()
                    {
                        (
                            if verified.is_error {
                                TaskStatus::Failed
                            } else {
                                TaskStatus::Completed
                            },
                            verified.text,
                        )
                    } else {
                        tracing::warn!(
                            "Delegated child receipt could not be saved; result is unavailable"
                        );
                        (TaskStatus::Interrupted, String::new())
                    }
                }
                Err(_) => (TaskStatus::Interrupted, String::new()),
            }
        } else {
            (TaskStatus::Interrupted, String::new())
        };
        crate::workspace_tasks::settle_running_delegation(
            self.data_root.clone(),
            binding.owner.clone(),
            task_id,
            child_id,
            binding.task_input(),
            outcome,
            result,
            exit_code,
        )
        .await
        .map_err(|error| error.message)
    }
    pub(super) fn read(&self, owner: &str, operation: Uuid) -> Result<Option<Record>> {
        if !valid_identity(owner) || operation.is_nil() {
            return Err("Invalid outbox lookup".into());
        }
        let db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        read_record(&db, owner, operation)
    }

    // Await this operation through completion: the blocking store callback can commit
    // after its awaiting future is dropped.
    pub(super) async fn stage_persisted_task_result(
        self: &Arc<Self>,
        owner: &str,
        operation: Uuid,
        queue_revision: u64,
    ) -> Result<Option<Terminal>> {
        let record = self.read(owner, operation)?.ok_or("Delegation not found")?;
        if Path::new(&record.binding.data_root) != self.data_root {
            return Err("Delegation data scope changed".into());
        }
        if let Some(terminal) = &record.terminal {
            validate_staged_terminal(&record, terminal)?;
            return Ok(Some(terminal.clone()));
        }
        let task_id = Uuid::parse_str(&record.binding.task).map_err(|_| "Invalid task ID")?;
        let outbox = Arc::clone(self);
        let owner = owner.to_owned();
        crate::workspace_tasks::with_durable_delegation_terminal(
            self.data_root.clone(),
            owner.clone(),
            task_id,
            move |mut task| {
                let staged: Result<Terminal> = (|| {
                    match &task.status {
                        crate::workspace_tasks::TaskStatus::Completed => {
                            let proof = record
                                .child_proof
                                .as_ref()
                                .ok_or("Delegated child result was not verified")?;
                            if proof.is_error
                                || task.exit_code != Some(proof.exit_code)
                                || proof.result_sha256 != result_digest(&task.result)
                            {
                                return Err(
                                    "Delegated child result does not match its receipt".into()
                                );
                            }
                        }
                        crate::workspace_tasks::TaskStatus::Failed => {
                            let proof = record
                                .child_proof
                                .as_ref()
                                .ok_or("Delegated child result was not verified")?;
                            if !proof.is_error
                                || task.exit_code != Some(proof.exit_code)
                                || proof.result_sha256 != result_digest(&task.result)
                            {
                                return Err(
                                    "Delegated child result does not match its receipt".into()
                                );
                            }
                        }
                        crate::workspace_tasks::TaskStatus::Cancelled
                        | crate::workspace_tasks::TaskStatus::Interrupted => {
                            task.result.clear();
                            task.error = None;
                            task.output_truncated = false;
                        }
                        _ => {}
                    }
                    let terminal = terminal_from_task(&record.binding, &task, queue_revision)?;
                    outbox.finish(&owner, operation, &terminal)?;
                    Ok(terminal)
                })();
                staged.map_err(crate::ApiError::internal)
            },
        )
        .await
        .map_err(|error| error.message)
    }

    fn record_verified_child_output(
        &self,
        owner: &str,
        operation: Uuid,
        stdout: &[u8],
        truncated: bool,
        exit_code: Option<i32>,
    ) -> Result<()> {
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin child result receipt")?;
        let record = read_record(&tx, owner, operation)?.ok_or("Delegation not found")?;
        if Path::new(&record.binding.data_root) != self.data_root {
            return Err("Delegation data scope changed".into());
        }
        let verified = verify_child_output(&record.binding, stdout, truncated, exit_code)?;
        let proof = ChildProof {
            session_id: record.binding.child_session.clone(),
            result_sha256: result_digest(&verified.text),
            displayed_sha256: result_digest(&displayed_result(&verified.text, false)),
            displayed_truncated_sha256: result_digest(&displayed_result(&verified.text, true)),
            is_error: verified.is_error,
            exit_code: exit_code.ok_or("Delegated child exit is unavailable")?,
        };
        validate_child_proof(&record.binding, &proof)?;
        if let Some(existing) = record.child_proof {
            return if existing == proof {
                Ok(())
            } else {
                Err("Child result receipt conflict".into())
            };
        }
        if record.terminal.is_some() {
            return Err("Delegation already has a terminal outcome".into());
        }
        tx.execute(
            "UPDATE records SET child_proof=?3 WHERE owner=?1 AND operation_id=?2",
            params![owner, operation.to_string(), encode(&proof)?],
        )
        .map_err(|_| "Cannot write child result receipt")?;
        tx.commit()
            .map_err(|_| "Cannot commit child result receipt")?;
        Ok(())
    }
    #[cfg(unix)]
    fn startup_pending(&self) -> Result<std::collections::HashSet<(String, Uuid)>> {
        let db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let mut statement = db
            .prepare("SELECT owner, operation_id FROM records WHERE terminal IS NULL")
            .map_err(|_| "Cannot inspect unfinished delegations")?;
        let mut rows = statement
            .query([])
            .map_err(|_| "Cannot inspect unfinished delegations")?;
        let mut pending = std::collections::HashSet::new();
        while let Some(row) = rows
            .next()
            .map_err(|_| "Cannot inspect unfinished delegations")?
        {
            let owner: String = row.get(0).map_err(|_| "Invalid delegation owner")?;
            let operation: String = row.get(1).map_err(|_| "Invalid delegation identity")?;
            let operation =
                Uuid::parse_str(&operation).map_err(|_| "Invalid delegation identity")?;
            if !valid_identity(&owner)
                || operation.is_nil()
                || pending.len() >= MAX_RECORDS as usize
            {
                return Err("Invalid unfinished delegation records".into());
            }
            pending.insert((owner, operation));
        }
        Ok(pending)
    }

    /// Enumerate retained records for one authenticated owner, including unfinished
    /// admissions. This never reads a parent or creates a queue.
    pub(super) fn list(&self, owner: &str) -> Result<Vec<Record>> {
        if !valid_identity(owner) {
            return Err("Invalid outbox lookup".into());
        }
        let db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let mut statement = db.prepare("SELECT operation_id, binding, terminal, receipt, child_proof FROM records WHERE owner=?1 ORDER BY operation_id").map_err(|_| "Cannot list outbox records")?;
        let mut rows = statement
            .query(params![owner])
            .map_err(|_| "Cannot list outbox records")?;
        let mut records = Vec::new();
        while let Some(row) = rows.next().map_err(|_| "Cannot list outbox records")? {
            if records.len() >= MAX_RECORDS as usize {
                return Err("Outbox record capacity exceeded".into());
            }
            let op: String = row.get(0).map_err(|_| "Corrupt outbox record")?;
            let record = parse_record(
                row.get(1).map_err(|_| "Corrupt outbox record")?,
                row.get(2).map_err(|_| "Corrupt outbox record")?,
                row.get(3).map_err(|_| "Corrupt outbox record")?,
                row.get(4).map_err(|_| "Corrupt outbox record")?,
            )?;
            if record.binding.owner != owner || record.binding.operation_id.to_string() != op {
                return Err("Inconsistent outbox identity".into());
            }
            records.push(record);
        }
        Ok(records)
    }
    /// Commit immutable outcome and exact queue mutation before any delivery attempt.
    fn finish(&self, owner: &str, operation: Uuid, terminal: &Terminal) -> Result<()> {
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin terminal write")?;
        let record = read_record(&tx, owner, operation)?.ok_or("Delegation not found")?;
        validate_terminal(&record.binding, terminal)?;
        if let Some(existing) = record.terminal {
            return if existing == *terminal {
                Ok(())
            } else {
                Err("Terminal outcome conflict".into())
            };
        }
        tx.execute(
            "UPDATE records SET terminal=?3 WHERE owner=?1 AND operation_id=?2",
            params![owner, operation.to_string(), encode(terminal)?],
        )
        .map_err(|_| "Cannot write terminal outcome")?;
        tx.commit().map_err(|_| "Cannot commit terminal outcome")?;
        Ok(())
    }
    /// `verify` is trusted integration code: it must confirm this exact mutation
    /// against the authoritative queue dedupe and receipt, under the parent gate.
    /// Receipt lookup without checking the exact mutation is insufficient.
    /// It must not re-enter this outbox.
    fn record_receipt<F>(
        &self,
        owner: &str,
        operation: Uuid,
        receipt: &MutationReceipt,
        verify: F,
    ) -> Result<()>
    where
        F: FnOnce(&Mutation, &MutationReceipt) -> Result<bool>,
    {
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin receipt write")?;
        let record = read_record(&tx, owner, operation)?.ok_or("Delegation not found")?;
        let terminal = record.terminal.ok_or("Terminal outcome not committed")?;
        validate_receipt(&terminal, receipt)?;
        if let Some(existing) = record.receipt {
            return if existing == *receipt {
                Ok(())
            } else {
                Err("Queue receipt conflict".into())
            };
        }
        if !verify(&terminal.mutation, receipt)? {
            return Err("Queue receipt payload was not verified".into());
        }
        tx.execute(
            "UPDATE records SET receipt=?3 WHERE owner=?1 AND operation_id=?2",
            params![owner, operation.to_string(), encode(receipt)?],
        )
        .map_err(|_| "Cannot write queue receipt")?;
        tx.commit().map_err(|_| "Cannot commit queue receipt")?;
        Ok(())
    }

    /// This only acknowledges an existing queue commit; it never submits work.
    /// The manager's lifecycle gates are process-local, so production assembly
    /// must additionally establish exclusive ownership of the parent lifecycle.
    pub(super) async fn reconcile_existing_receipt(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
    ) -> Result<Option<()>> {
        let record = self.read(owner, operation)?.ok_or("Delegation not found")?;
        if Path::new(&record.binding.data_root) != self.data_root {
            return Err("Delegation data scope changed".into());
        }
        let terminal = record
            .terminal
            .as_ref()
            .ok_or("Terminal outcome not committed")?;
        validate_staged_terminal(&record, terminal)?;
        manager
            .confirm_existing_bound_queue_receipt(
                owner,
                &self.data_root,
                &record.binding.parent_session,
                Path::new(&record.binding.workspace),
                record.binding.queue_identity,
                record.binding.parent_incarnation,
                &terminal.mutation,
                |receipt| {
                    self.record_receipt(owner, operation, receipt, |mutation, expected| {
                        Ok(mutation == &terminal.mutation && expected == receipt)
                    })
                },
            )
            .await
            .map_err(|error| error.message)
    }

    async fn deliver_bound_parent(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
    ) -> Result<()> {
        let binding = self
            .read(owner, operation)?
            .ok_or("Delegation not found")?
            .binding;
        self.deliver_bound_parent_with(
            manager,
            owner,
            operation,
            |queue, scope, identity, mutation| {
                submit_bound_delegation(manager, &binding, queue, scope, identity, mutation)
            },
        )
        .await
    }

    async fn deliver_bound_parent_with<F>(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
        submit: F,
    ) -> Result<()>
    where
        F: FnOnce(
            &crate::followup_queue::QueueStore,
            &crate::followup_queue::QueueScope,
            Uuid,
            Mutation,
        ) -> Result<MutationReceipt>,
    {
        self.deliver_bound_parent_with_guard(manager, owner, operation, || Ok(()), submit)
            .await
    }

    async fn deliver_bound_parent_with_guard<G, Enter, F>(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
        enter: Enter,
        submit: F,
    ) -> Result<()>
    where
        Enter: FnOnce() -> Result<G>,
        F: FnOnce(
            &crate::followup_queue::QueueStore,
            &crate::followup_queue::QueueScope,
            Uuid,
            Mutation,
        ) -> Result<MutationReceipt>,
    {
        let record = self.read(owner, operation)?.ok_or("Delegation not found")?;
        if Path::new(&record.binding.data_root) != self.data_root {
            return Err("Delegation data scope changed".into());
        }
        let binding = record.binding;
        manager
            .with_bound_parent_queue(
                owner,
                &self.data_root,
                &binding.parent_session,
                Path::new(&binding.workspace),
                binding.queue_identity,
                |queue, scope, snapshot, incarnation| {
                    let _admission = enter()?;
                    let record = self.read(owner, operation)?.ok_or("Delegation not found")?;
                    if record.binding != binding {
                        return Err("Delegation binding changed".into());
                    }
                    if binding.parent_incarnation.is_none() || binding.parent_incarnation != incarnation {
                        return Err("Delegation parent identity is missing or changed; result retained for review".into());
                    }
                    let terminal = record
                        .terminal
                        .as_ref()
                        .ok_or("Terminal outcome not committed")?;
                    validate_staged_terminal(&record, terminal)?;
                    if let Some(receipt) = queue
                        .verify_receipt_with_identity(
                            scope,
                            binding.queue_identity,
                            &terminal.mutation,
                        )
                        .map_err(|error| format!("Queue receipt unavailable: {error:?}"))?
                    {
                        return self.record_receipt(
                            owner,
                            operation,
                            &receipt,
                            |mutation, expected| {
                                Ok(mutation == &terminal.mutation && expected == &receipt)
                            },
                        );
                    }
                    if record.receipt.is_some() {
                        return Err("Recorded delivery receipt is no longer available".into());
                    }
                    let terminal = self.bind_first_delivery(owner, operation, snapshot.revision)?;
                    let receipt = match submit(
                        queue,
                        scope,
                        binding.queue_identity,
                        terminal.mutation.clone(),
                    ) {
                        Ok(receipt) => receipt,
                        Err(error) if is_unapplied_busy(&error) => {
                            self.release_unapplied_delivery(owner, operation)?;
                            return Err("Queue storage is busy; delivery will be retried".into());
                        }
                        Err(_) => return Err("Delegated delivery outcome is uncertain".into()),
                    };
                    let verified = queue
                        .verify_receipt_with_identity(
                            scope,
                            binding.queue_identity,
                            &terminal.mutation,
                        )
                        .map_err(|_| "Delegated delivery outcome is uncertain".to_string())?
                        .ok_or("Delegated delivery outcome is uncertain")?;
                    if verified != receipt {
                        return Err("Queue receipt changed".into());
                    }
                    self.record_receipt(owner, operation, &verified, |mutation, expected| {
                        Ok(mutation == &terminal.mutation && expected == &verified)
                    })
                },
            )
            .await
            .map_err(|error| error.message)
    }

    fn bind_first_delivery(&self, owner: &str, operation: Uuid, revision: u64) -> Result<Terminal> {
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin delivery attempt")?;
        let record = read_record(&tx, owner, operation)?.ok_or("Delegation not found")?;
        let mut terminal = record
            .terminal
            .clone()
            .ok_or("Terminal outcome not committed")?;
        validate_staged_terminal(&record, &terminal)?;
        if record.receipt.is_some() {
            return Err("Delegated delivery already acknowledged".into());
        }
        terminal.mutation.expected_queue_revision = revision;
        validate_terminal(&record.binding, &terminal)?;
        let changed = tx.execute("UPDATE records SET terminal=?3,delivery_attempted=1 WHERE owner=?1 AND operation_id=?2 AND delivery_attempted=0 AND receipt IS NULL",
            params![owner, operation.to_string(), encode(&terminal)?]).map_err(|_| "Cannot claim delivery attempt")?;
        if changed != 1 {
            return Err("Delegated delivery outcome is uncertain".into());
        }
        tx.commit().map_err(|_| "Cannot commit delivery attempt")?;
        Ok(terminal)
    }

    /// Undoes a delivery claim whose submission provably never reached the queue.
    fn release_unapplied_delivery(&self, owner: &str, operation: Uuid) -> Result<()> {
        let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Cannot begin delivery release")?;
        let changed = tx.execute("UPDATE records SET delivery_attempted=0 WHERE owner=?1 AND operation_id=?2 AND delivery_attempted=1 AND receipt IS NULL AND terminal IS NOT NULL",
            params![owner, operation.to_string()]).map_err(|_| "Cannot release delivery attempt")?;
        if changed != 1 {
            return Err("Delivery attempt cannot be released".into());
        }
        tx.commit().map_err(|_| "Cannot commit delivery release")?;
        Ok(())
    }

    /// Bounded in-process retry of a transient delivery failure. Anything still
    /// failing is retained for owner recovery on the next session access.
    #[cfg(unix)]
    async fn deliver_bound_parent_with_retry(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
    ) -> Result<()> {
        let mut delay = std::time::Duration::from_millis(250);
        for _ in 0..6 {
            match self.deliver_bound_parent(manager, owner, operation).await {
                Err(error) if is_transient_delivery_error(&error) => {
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
                outcome => return outcome,
            }
        }
        self.deliver_bound_parent(manager, owner, operation).await
    }

    /// Test-only adapter: the submitter must hold exclusive parent ownership and
    /// establish that the original queue has not been replaced. A durable attempt
    /// with no matching receipt remains uncertain and is never replayed.
    #[cfg(test)]
    async fn deliver_with_exclusive_parent<F, Fut>(
        &self,
        manager: &crate::structured::StructuredSessionManager,
        owner: &str,
        operation: Uuid,
        submit: F,
    ) -> Result<Option<()>>
    where
        F: FnOnce(Binding, Mutation) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        if self
            .reconcile_existing_receipt(manager, owner, operation)
            .await?
            .is_some()
        {
            return Ok(Some(()));
        }
        let record = self.read(owner, operation)?.ok_or("Delegation not found")?;
        let terminal = record
            .terminal
            .as_ref()
            .ok_or("Terminal outcome not committed")?;
        validate_staged_terminal(&record, terminal)?;
        {
            let mut db = self.db.lock().map_err(|_| "Outbox lock unavailable")?;
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "Cannot begin delivery attempt")?;
            let changed = tx.execute("UPDATE records SET delivery_attempted=1 WHERE owner=?1 AND operation_id=?2 AND delivery_attempted=0 AND terminal IS NOT NULL", params![owner, operation.to_string()])
                .map_err(|_| "Cannot claim delivery attempt")?;
            if changed != 1 {
                return Err("Delegated delivery outcome is uncertain".into());
            }
            tx.commit().map_err(|_| "Cannot commit delivery attempt")?;
        }
        let submission = submit(record.binding, terminal.mutation.clone()).await;
        if self
            .reconcile_existing_receipt(manager, owner, operation)
            .await?
            .is_some()
        {
            return Ok(Some(()));
        }
        let _ = submission;
        Err("Delegated delivery outcome is uncertain".into())
    }
}
fn read_record(db: &Connection, owner: &str, op: Uuid) -> Result<Option<Record>> {
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT binding, terminal, receipt, child_proof FROM records WHERE owner=?1 AND operation_id=?2",
            params![owner, op.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|_| "Cannot read outbox record")?;
    let record = row
        .map(|(b, t, r, p)| parse_record(b, t, r, p))
        .transpose()?;
    if record
        .as_ref()
        .is_some_and(|r| r.binding.owner != owner || r.binding.operation_id != op)
    {
        return Err("Inconsistent outbox identity".into());
    }
    Ok(record)
}
fn parse_record(
    b: String,
    t: Option<String>,
    r: Option<String>,
    p: Option<String>,
) -> Result<Record> {
    if b.len() > 6 * (7 * 512 + MAX_WORKSPACE_BYTES + MAX_PROMPT_BYTES) + 4096
        || t.as_ref()
            .is_some_and(|v| v.len() > 6 * (MAX_RESULT_BYTES + MAX_QUEUE_TEXT_BYTES) + 4096)
        || r.as_ref().is_some_and(|v| v.len() > 4096)
        || p.as_ref().is_some_and(|v| v.len() > 4096)
    {
        return Err("Oversized outbox record".into());
    }
    let binding: Binding = decode(&b)?;
    validate_binding(&binding)?;
    let terminal: Option<Terminal> = t.map(|s| decode(&s)).transpose()?;
    let receipt: Option<MutationReceipt> = r.map(|s| decode(&s)).transpose()?;
    let child_proof: Option<ChildProof> = p.map(|s| decode(&s)).transpose()?;
    if let Some(t) = &terminal {
        validate_terminal(&binding, t)?;
    }
    if let Some(r) = &receipt {
        validate_receipt(terminal.as_ref().ok_or("Receipt without outcome")?, r)?;
    }
    if let Some(proof) = &child_proof {
        validate_child_proof(&binding, proof)?;
    }
    Ok(Record {
        binding,
        terminal,
        receipt,
        child_proof,
    })
}
#[cfg(unix)]
fn limit_database(db: &Connection) -> Result<()> {
    let size: u64 = db
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|_| "Cannot inspect outbox page size")?;
    if size == 0 || size > MAX_DB_BYTES {
        return Err("Invalid outbox page size".into());
    }
    let pages = MAX_DB_BYTES / size;
    db.pragma_update(None, "max_page_count", pages)
        .map_err(|_| "Cannot limit outbox database")?;
    let actual: u64 = db
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .map_err(|_| "Cannot inspect outbox limit")?;
    if actual > pages {
        return Err("Outbox database exceeds its limit".into());
    }
    Ok(())
}
#[cfg(unix)]
fn outbox_identity(path: &Path) -> Result<OutboxIdentity> {
    use std::os::unix::fs::MetadataExt;
    check_parent(path)?;
    check_directory(path, true)?;
    let lock = path.join("owner.lock");
    let database = path.join("outbox.sqlite3");
    check_file(&lock)?;
    check_file(&database)?;
    let identity = |path: &Path| -> Result<(u64, u64)> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Outbox identity unavailable")?;
        Ok((metadata.dev(), metadata.ino()))
    };
    Ok(OutboxIdentity {
        version: 1,
        data_root: path
            .parent()
            .and_then(Path::to_str)
            .ok_or("Invalid outbox data directory")?
            .into(),
        root: identity(path.parent().ok_or("Missing outbox data directory")?)?,
        directory: identity(path)?,
        lock: identity(&lock)?,
        database: identity(&database)?,
    })
}

#[cfg(unix)]
fn lock_file(file: &File) -> Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Outbox is already in use".into());
    }
    Ok(())
}
#[cfg(unix)]
fn check_parent(path: &Path) -> Result<()> {
    use std::path::Component;
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Outbox path must be absolute and normalized".into());
    }
    let parent = path.parent().ok_or("Missing outbox parent")?;
    let mut current = std::path::PathBuf::from("/");
    for part in parent.components() {
        if let Component::Normal(p) = part {
            current.push(p);
            check_directory(&current, false)?;
        }
    }
    Ok(())
}
#[cfg(unix)]
fn check_directory(path: &Path, private: bool) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).map_err(|_| "Cannot inspect outbox directory")?;
    let uid = unsafe { libc::geteuid() };
    if !m.is_dir()
        || (m.uid() != uid && m.uid() != 0)
        || (private && (m.uid() != uid || m.mode() & 0o077 != 0))
        || (!private && m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
    {
        return Err("Unsafe outbox directory".into());
    }
    Ok(())
}
#[cfg(unix)]
fn check_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).map_err(|_| "Cannot inspect outbox file")?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.nlink() != 1
        || m.len() > MAX_DB_BYTES
    {
        return Err("Unsafe outbox file".into());
    }
    Ok(())
}
#[cfg(unix)]
#[path = "delegation_owner_cleanup.rs"]
pub(crate) mod owner_cleanup_prototype;

#[cfg(unix)]
#[path = "delegation_prune.rs"]
mod prune;

#[cfg(all(test, unix))]
#[path = "delegation_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::followup_queue::{Mutation, MutationReceipt, QueueOperation};
    use tempfile::TempDir;
    use uuid::Uuid;

    #[cfg(unix)]
    #[test]
    fn provider_child_fixture() {
        use std::os::fd::AsRawFd;
        let Some(args) = std::env::var_os("V4_DELEGATION_FIXTURE_ARGS") else {
            return;
        };
        let args: Vec<String> = serde_json::from_str(&args.to_string_lossy()).unwrap();
        let data = std::env::var_os("V4_DELEGATION_FIXTURE_DATA").unwrap();
        if let Some(pid_file) = std::env::var_os("V4_DELEGATION_FIXTURE_PID") {
            std::fs::write(pid_file, std::process::id().to_string()).unwrap();
        }
        let output =
            std::fs::File::create(std::env::var_os("V4_DELEGATION_FIXTURE_OUTPUT").unwrap())
                .unwrap();
        assert!(unsafe { libc::dup2(output.as_raw_fd(), libc::STDOUT_FILENO) } >= 0);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let code = runtime
            .block_on(super::super::run(Path::new(&data), &args))
            .unwrap_or_else(|error| {
                eprintln!("{error}");
                1
            });
        std::process::exit(code);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prepared_launch_rechecks_cancellation_and_workspace_before_spawn() {
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use async_trait::async_trait;
        use terminal_v4_core::StructuredSessionEvent;
        struct Allow;
        #[async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool> {
                Ok(true)
            }
        }
        let (data, outbox) = store();
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let session = super::super::new_session("deepseek", "deepseek-chat", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let cancellation = Cancellation::default();
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "cancel-test",
            &serde_json::json!({"prompt":"Inspect"}),
            &Allow,
            &cancellation,
        )
        .await
        .unwrap();
        let (task, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = parent.path().join("started");
        let mut fixture = tokio::process::Command::new("/usr/bin/touch");
        fixture.arg(&marker).kill_on_drop(true);
        prepared.command = fixture;
        cancellation.cancel();
        assert!(prepared.launch().is_err());
        assert!(!marker.exists());
        assert_eq!(
            task.status,
            crate::workspace_tasks::TaskStatus::DelegationHeld
        );

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "scope-test",
            &serde_json::json!({"prompt":"Inspect"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let mut fixture = tokio::process::Command::new("/usr/bin/touch");
        fixture.arg(&marker).kill_on_drop(true);
        prepared.command = fixture;
        let moved = parent.path().join("moved-workspace");
        std::fs::rename(&workspace, &moved).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        assert!(prepared.launch().is_err());
        assert!(!marker.exists());
        std::fs::remove_dir(&workspace).unwrap();
        std::fs::rename(&moved, &workspace).unwrap();

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "data-scope-test",
            &serde_json::json!({"prompt":"Inspect"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let mut fixture = tokio::process::Command::new("/usr/bin/touch");
        fixture.arg(&marker).kill_on_drop(true);
        prepared.command = fixture;
        let moved_data = data.path().with_extension("displaced");
        std::fs::rename(data.path(), &moved_data).unwrap();
        std::fs::create_dir(data.path()).unwrap();
        assert!(prepared.launch().is_err());
        assert!(!marker.exists());
        std::fs::remove_dir(data.path()).unwrap();
        std::fs::rename(&moved_data, data.path()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approved_read_only_child_returns_verified_provider_result() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use async_trait::async_trait;
        use axum::{routing::post, Json};
        use terminal_v4_core::{AppConfig, StructuredSessionEvent};

        struct Allow;
        #[async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool> {
                Ok(true)
            }
        }

        let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = Arc::clone(&requests);
        let router = axum::Router::new().fallback(post(move |Json(body): Json<serde_json::Value>| {
            let captured = Arc::clone(&captured);
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                let result = if requests.len() == 1 {
                    serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[
                        {"id":"write","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"fixture.txt\",\"content\":\"changed\"}"}},
                        {"id":"read","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"fixture.txt\"}"}}
                    ]}}]})
                } else {
                    serde_json::json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixture answer"}}]})
                };
                Json(result)
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("fixture.txt"), "original").unwrap();
        let db = rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE api_key_vault(user_id TEXT, key_name TEXT, key_value TEXT, created_at TEXT)").unwrap();
        let key =
            crate::vault::encrypt_secret("fixture-provider-key", "fixture-vault-key").unwrap();
        db.execute(
            "INSERT INTO api_key_vault VALUES(?1,?2,?3,'2020')",
            params!["owner", "terminal-v4:provider:deepseek", key],
        )
        .unwrap();
        drop(db);
        let workspace_path = workspace.path().canonicalize().unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut session = super::super::new_session("deepseek", "deepseek-chat", &workspace_path);
        session.id = crate::structured::engine_session_id(&parent.id).unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: parent.id,
            turn_id: Uuid::new_v4().to_string(),
        };
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let queue_scope = QueueScope::new("owner", &workspace_path, &scope.session_id).unwrap();
        let pause = queue
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        let queue_identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "fixture-call",
            &serde_json::json!({"prompt":"Inspect fixture.txt"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let binding = approved.binding().clone();
        let (task, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let args: Vec<String> = prepared
            .command
            .as_std()
            .get_args()
            .skip(1)
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let output_file = data.path().join("child-events.jsonl");
        let mut fixture = tokio::process::Command::new(std::env::current_exe().unwrap());
        fixture
            .args([
                "--exact",
                "v4_agent::delegation_outbox::tests::provider_child_fixture",
                "--nocapture",
            ])
            .current_dir(&workspace_path)
            .env(
                "V4_DELEGATION_FIXTURE_ARGS",
                serde_json::to_string(&args).unwrap(),
            )
            .env("V4_DELEGATION_FIXTURE_DATA", data.path())
            .env("V4_DELEGATION_FIXTURE_OUTPUT", &output_file)
            .env("VAULT_ENCRYPTION_KEY", "fixture-vault-key")
            .env("DEEPSEEK_BASE_URL", format!("http://{address}/v1"))
            .env("NO_PROXY", "*")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        prepared.command = fixture;
        let (running_task, mut child) = outbox
            .launch_prepared_held_child(&binding, prepared, &Cancellation::default(), None)
            .await
            .unwrap();
        let _lifeline = child.stdin.take();
        assert_eq!(
            running_task.status,
            crate::workspace_tasks::TaskStatus::Running
        );
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
        assert!(
            output.status.success(),
            "child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = std::fs::read(output_file).unwrap();
        let verified = verify_child_output(&binding, &stdout, false, output.status.code()).unwrap();
        assert_eq!(verified.text, "Fixture answer");
        outbox
            .record_verified_child_output(
                &binding.owner,
                binding.operation_id,
                &stdout,
                false,
                output.status.code(),
            )
            .unwrap();
        crate::workspace_tasks::settle_running_delegation(
            data.path().canonicalize().unwrap(),
            binding.owner.clone(),
            task.id,
            Uuid::parse_str(&binding.child_session).unwrap(),
            binding.task_input(),
            crate::workspace_tasks::TaskStatus::Completed,
            verified.text,
            output.status.code(),
        )
        .await
        .unwrap();
        let terminal = outbox
            .stage_persisted_task_result(&binding.owner, binding.operation_id, pause.queue_revision)
            .await
            .unwrap()
            .unwrap();
        let actor = queue.clone();
        let actor_scope = queue_scope.clone();
        assert_eq!(
            outbox
                .deliver_with_exclusive_parent(
                    &manager,
                    &binding.owner,
                    binding.operation_id,
                    move |scope, mutation| async move {
                        actor
                            .mutate_existing_with_identity(
                                &actor_scope,
                                scope.queue_identity,
                                mutation,
                            )
                            .map(|_| ())
                            .map_err(|error| format!("{error:?}"))
                    }
                )
                .await
                .unwrap(),
            Some(())
        );
        let snapshot = queue.load(&queue_scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason),
            (QueueMode::Held, Some(HoldReason::Manual))
        );
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.items[0].text.contains("Fixture answer"));
        assert_eq!(
            outbox
                .read(&binding.owner, binding.operation_id)
                .unwrap()
                .unwrap()
                .terminal,
            Some(terminal)
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("fixture.txt")).unwrap(),
            "original"
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .to_string()
            .contains("Tool denied by read-only child policy"));
        assert!(requests[1].to_string().contains("original"));
        drop(requests);
        server.abort();

        let (entered, pending_request) = tokio::sync::oneshot::channel();
        let entered = Arc::new(Mutex::new(Some(entered)));
        let pending_router =
            axum::Router::new().fallback(post(move |Json(_): Json<serde_json::Value>| {
                let entered = Arc::clone(&entered);
                async move {
                    if let Some(sender) = entered.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                    std::future::pending::<Json<serde_json::Value>>().await
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pending_address = listener.local_addr().unwrap();
        let pending_server =
            tokio::spawn(async move { axum::serve(listener, pending_router).await.unwrap() });
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "interrupted-call",
            &serde_json::json!({"prompt":"Inspect again"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let interrupted = approved.binding().clone();
        let (_, command) = outbox
            .prepare_reviewed_held_child(data.path(), approved)
            .await
            .unwrap();
        let args: Vec<String> = command
            .as_std()
            .get_args()
            .skip(1)
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let output_file = data.path().join("interrupted-child-events.jsonl");
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "v4_agent::delegation_outbox::tests::provider_child_fixture",
                "--nocapture",
            ])
            .current_dir(&workspace_path)
            .env(
                "V4_DELEGATION_FIXTURE_ARGS",
                serde_json::to_string(&args).unwrap(),
            )
            .env("V4_DELEGATION_FIXTURE_DATA", data.path())
            .env("V4_DELEGATION_FIXTURE_OUTPUT", &output_file)
            .env("VAULT_ENCRYPTION_KEY", "fixture-vault-key")
            .env("DEEPSEEK_BASE_URL", format!("http://{pending_address}/v1"))
            .env("NO_PROXY", "*")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), pending_request)
            .await
            .unwrap()
            .unwrap();
        child.kill().await.unwrap();
        let status = child.wait().await.unwrap();
        let partial = std::fs::read(output_file).unwrap();
        assert!(verify_child_output(&interrupted, &partial, false, status.code()).is_err());
        assert!(outbox
            .record_verified_child_output(
                &interrupted.owner,
                interrupted.operation_id,
                &partial,
                false,
                status.code()
            )
            .is_err());
        assert_eq!(
            outbox
                .stage_persisted_task_result(&interrupted.owner, interrupted.operation_id, 0)
                .await
                .unwrap(),
            None
        );
        assert_eq!(queue.load(&queue_scope).unwrap().items.len(), 1);
        pending_server.abort();
    }

    fn binding() -> Binding {
        Binding {
            owner: "owner".into(),
            data_root: "/tmp".into(),
            parent_session: "parent".into(),
            parent_turn: "turn".into(),
            parent_incarnation: None,
            queue_identity: Uuid::new_v4(),
            child_session: "child".into(),
            task: "task".into(),
            workspace: "/tmp/workspace".into(),
            provider: "openai-api".into(),
            model: "model-1".into(),
            prompt: "Inspect the project".into(),
            permission: Permission::ReadOnlyChild,
            operation_id: Uuid::new_v4(),
            authorization: None,
            #[cfg(unix)]
            paired_authorization: None,
            #[cfg(unix)]
            paired_attestation: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn paired_binding_requires_matching_owner_and_exclusive_authority() {
        let now = super::super::interaction::now_ms();
        let mut b = binding();
        let incarnation = Uuid::new_v4();
        b.parent_incarnation = Some(incarnation);
        let grant: crate::paired_environments::PairedGrantAuthority =
            serde_json::from_value(serde_json::json!({
                "owner": "owner",
                "grant_id": Uuid::new_v4(),
                "created": now / 1000 - 1,
                "expires_at_ms": (now / 1000 + 60) * 1000,
                "revision": "a".repeat(64),
            }))
            .unwrap();
        b.paired_authorization = Some(grant.clone());
        assert!(validate_binding(&b).is_ok());
        b.owner = "other".into();
        assert!(validate_binding(&b).is_err());
        b.owner = "owner".into();
        b.parent_incarnation = None;
        assert!(validate_binding(&b).is_err());
        b.parent_incarnation = Some(incarnation);
        b.authorization = Some(DelegationAuthorization {
            session_incarnation: incarnation,
            generation: 0,
            expires_at_ms: now + 60_000,
        });
        assert!(validate_binding(&b).is_err());
        b.authorization = None;
        let encoded = serde_json::to_vec(&b).unwrap();
        assert_eq!(serde_json::from_slice::<Binding>(&encoded).unwrap(), b);
        let (_dir, outbox) = store();
        outbox.admit(&b).unwrap();
        assert_eq!(
            outbox
                .read("owner", b.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            b
        );
        let mut changed = b.clone();
        changed.paired_authorization = None;
        assert!(outbox.admit(&changed).is_err());
        let expired: crate::paired_environments::PairedGrantAuthority =
            serde_json::from_value(serde_json::json!({
                "owner": "owner",
                "grant_id": Uuid::new_v4(),
                "created": now / 1000 - 120,
                "expires_at_ms": (now / 1000 - 60) * 1000,
                "revision": "a".repeat(64),
            }))
            .unwrap();
        assert!(!expired.valid_for("owner", now));
        b.paired_authorization = Some(expired);
        assert!(validate_binding(&b).is_ok());
        let mut legacy = serde_json::to_value(&b).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("paired_authorization");
        assert!(serde_json::from_value::<Binding>(legacy)
            .unwrap()
            .paired_authorization
            .is_none());
    }
    fn terminal(b: &Binding) -> Terminal {
        Terminal {
            outcome: Outcome::Succeeded,
            result: "exact result".into(),
            source_digest: None,
            mutation: Mutation {
                operation_id: b.operation_id,
                expected_queue_revision: 5,
                operation: QueueOperation::Enqueue {
                    item_id: Uuid::new_v4(),
                    text: "exact result".into(),
                    run_when_idle: false,
                },
            },
        }
    }
    fn receipt(t: &Terminal) -> MutationReceipt {
        let QueueOperation::Enqueue { item_id, .. } = t.mutation.operation else {
            unreachable!()
        };
        MutationReceipt {
            operation_id: t.mutation.operation_id,
            queue_revision: 6,
            item_id: Some(item_id),
            item_revision: Some(1),
        }
    }
    fn store() -> (TempDir, Outbox) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Outbox::create(&dir.path().join("outbox")).unwrap();
        (dir, outbox)
    }

    #[cfg(unix)]
    #[test]
    fn turn_binding_is_scoped_and_does_not_keep_the_manager_alive() {
        use crate::v4_agent::interaction::{ActionScope, TurnResources};
        let (data, outbox) = store();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager =
            crate::structured::StructuredSessionManager::new(terminal_v4_core::AppConfig {
                data_dir: data.path().into(),
                ..Default::default()
            });
        manager.bind_live_ownership().unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::new(outbox)).unwrap());
        manager
            .bind_delegation_supervisor(supervisor.clone())
            .unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::new_v4().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let turn = Arc::new(DelegationTurn::new(manager, supervisor, scope.clone(), 7).unwrap());
        let resources = TurnResources::default();
        resources.bind_delegation(&turn).unwrap();
        assert!(Arc::ptr_eq(&resources.delegation(&scope).unwrap(), &turn));
        assert!(super::super::background_delegation_definition(
            &resources,
            &scope,
            "deepseek",
            super::super::ToolPolicy::Standard
        )
        .is_some());
        assert!(super::super::background_delegation_definition(
            &resources,
            &scope,
            "deepseek",
            super::super::ToolPolicy::ReadOnlyChild
        )
        .is_none());
        assert!(super::super::background_delegation_definition(
            &resources,
            &scope,
            "not-a-provider",
            super::super::ToolPolicy::Standard
        )
        .is_none());
        let mut wrong_scope = scope.clone();
        wrong_scope.turn_id = Uuid::new_v4().to_string();
        assert!(resources.delegation(&wrong_scope).is_none());
        assert!(super::super::background_delegation_definition(
            &resources,
            &wrong_scope,
            "deepseek",
            super::super::ToolPolicy::Standard
        )
        .is_none());
        drop(turn);
        assert!(resources.delegation(&scope).is_none());
    }

    #[tokio::test]
    async fn supervised_child_persists_only_verified_complete_output() {
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use terminal_v4_core::StructuredSessionEvent;
        struct Allow;
        #[async_trait::async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool> {
                Ok(true)
            }
        }
        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace_root = tempfile::tempdir().unwrap();
        let workspace = workspace_root.path().canonicalize().unwrap();
        let session = super::super::new_session("deepseek", "deepseek-chat", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "fixture-call",
            &serde_json::json!({"prompt":"Inspect"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":binding.child_session,"text":"Verified answer","is_error":false}).to_string();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$1\"", "fixture", &output]);
        prepared.command = command;
        let (started, supervisor) = Arc::clone(&outbox).spawn_prepared_held_child(
            binding.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        let task = started.await.unwrap().unwrap();
        assert_eq!(task.status, crate::workspace_tasks::TaskStatus::Running);
        let saved = supervisor.await.unwrap().unwrap();
        assert_eq!(
            (saved.status, saved.result.as_str()),
            (
                crate::workspace_tasks::TaskStatus::Completed,
                "Verified answer"
            )
        );
        let staged = outbox
            .stage_persisted_task_result("owner", binding.operation_id, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (staged.outcome, staged.result.as_str()),
            (Outcome::Succeeded, "Verified answer")
        );

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "cancel-call",
            &serde_json::json!({"prompt":"Inspect again"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let cancelled_binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = data.path().join("child-started");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"; while :; do sleep 1; done")
            .arg("fixture")
            .arg(&marker);
        prepared.command = command;
        let cancel = Cancellation::default();
        let (started, supervisor) = Arc::clone(&outbox).spawn_prepared_held_child(
            cancelled_binding.clone(),
            prepared,
            cancel.clone(),
            Cancellation::default(),
        );
        assert_eq!(
            started.await.unwrap().unwrap().status,
            crate::workspace_tasks::TaskStatus::Running
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("child did not start");
        cancel.cancel();
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(10), supervisor)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            (cancelled.status, cancelled.result.as_str()),
            (crate::workspace_tasks::TaskStatus::Cancelled, "")
        );
        let staged = outbox
            .stage_persisted_task_result("owner", cancelled_binding.operation_id, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(staged.outcome, Outcome::Cancelled);

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "lost-receipt-call",
            &serde_json::json!({"prompt":"Inspect once more"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let lost_binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":lost_binding.child_session,"text":"Still owned","is_error":false}).to_string();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$1\"", "fixture", &output]);
        prepared.command = command;
        let (receipt, supervisor) = Arc::clone(&outbox).spawn_prepared_held_child(
            lost_binding.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        drop(receipt);
        let completed = supervisor.await.unwrap().unwrap();
        assert_eq!(
            (completed.status, completed.result.as_str()),
            (crate::workspace_tasks::TaskStatus::Completed, "Still owned")
        );
        assert_eq!(
            outbox
                .stage_persisted_task_result("owner", lost_binding.operation_id, 0)
                .await
                .unwrap()
                .unwrap()
                .outcome,
            Outcome::Succeeded
        );

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "failed-proof-call",
            &serde_json::json!({"prompt":"Inspect receipt failure"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let failed_proof_binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":failed_proof_binding.child_session,"text":"Unrecorded answer","is_error":false}).to_string();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$1\"", "fixture", &output]);
        prepared.command = command;
        outbox.db.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_child_proof BEFORE UPDATE OF child_proof ON records BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;"
        ).unwrap();
        let (started, supervisor) = Arc::clone(&outbox).spawn_prepared_held_child(
            failed_proof_binding.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        assert_eq!(
            started.await.unwrap().unwrap().status,
            crate::workspace_tasks::TaskStatus::Running
        );
        let settled = supervisor.await.unwrap().unwrap();
        assert_eq!(
            (settled.status, settled.result.as_str()),
            (crate::workspace_tasks::TaskStatus::Interrupted, "")
        );
        let staged = outbox
            .stage_persisted_task_result("owner", failed_proof_binding.operation_id, 0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (staged.outcome, staged.result.as_str()),
            (Outcome::Interrupted, "No answer was returned.")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervised_child_delivers_once_to_held_parent_queue() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use terminal_v4_core::{AppConfig, StructuredSessionEvent};

        struct Allow;
        #[async_trait::async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool> {
                Ok(true)
            }
        }

        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().canonicalize().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut session = super::super::new_session("deepseek", "deepseek-chat", &workspace_path);
        session.id = crate::structured::engine_session_id(&parent.id).unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: parent.id,
            turn_id: Uuid::new_v4().to_string(),
        };
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let queue_scope = QueueScope::new("owner", &workspace_path, &scope.session_id).unwrap();
        queue
            .mutate(
                &queue_scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        let queue_identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "fixture",
            &serde_json::json!({"prompt":"Inspect"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":binding.child_session,"text":"Investigation complete","is_error":false}).to_string();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printf '%s\\n' \"$1\"", "fixture", &output]);
        prepared.command = command;
        let (started, supervisor) = Arc::clone(&outbox).spawn_and_deliver(
            manager.clone(),
            binding.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        assert_eq!(
            started.await.unwrap().unwrap().status,
            crate::workspace_tasks::TaskStatus::Running
        );
        assert_eq!(
            supervisor.await.unwrap().unwrap().status,
            crate::workspace_tasks::TaskStatus::Completed
        );
        let snapshot = queue.load(&queue_scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason, snapshot.items.len()),
            (QueueMode::Held, Some(HoldReason::Manual), 1)
        );
        assert!(snapshot.items[0].text.contains("Investigation complete"));
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_some());
        outbox
            .deliver_bound_parent(&manager, "owner", binding.operation_id)
            .await
            .unwrap();
        assert_eq!(queue.load(&queue_scope).unwrap().items.len(), 1);

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "shutdown-delivery",
            &serde_json::json!({"prompt":"Inspect before shutdown"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let pending = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":pending.child_session,"text":"Saved before shutdown","is_error":false}).to_string();
        let release_child = data.path().join("release-before-shutdown");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("while [ ! -f \"$2\" ]; do sleep 0.05; done; printf '%s\\n' \"$1\"")
            .arg("fixture")
            .arg(output)
            .arg(&release_child);
        prepared.command = command;
        let shutdown = Cancellation::default();
        let (started, mut supervisor) = Arc::clone(&outbox).spawn_and_deliver(
            manager.clone(),
            pending.clone(),
            prepared,
            Cancellation::default(),
            shutdown.clone(),
        );
        started.await.unwrap().unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release_gate, release_gate_rx) = tokio::sync::oneshot::channel();
        let gate_manager = manager.clone();
        let gate_binding = pending.clone();
        let gate = tokio::spawn(async move {
            gate_manager
                .with_bound_parent_launch(
                    &gate_binding.owner,
                    Path::new(&gate_binding.data_root),
                    &gate_binding.parent_session,
                    Path::new(&gate_binding.workspace),
                    gate_binding.queue_identity,
                    gate_binding.parent_incarnation,
                    &Cancellation::default(),
                    || async move {
                        entered.send(()).unwrap();
                        release_gate_rx.await.map_err(|_| "gate closed".to_string())
                    },
                )
                .await
        });
        entered_rx.await.unwrap();
        std::fs::write(release_child, "release").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while outbox
                .read("owner", pending.operation_id)
                .unwrap()
                .unwrap()
                .terminal
                .is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        shutdown.cancel();
        let stopped =
            tokio::time::timeout(std::time::Duration::from_secs(2), &mut supervisor).await;
        release_gate.send(()).unwrap();
        gate.await.unwrap().unwrap();
        assert!(
            stopped.is_ok(),
            "Shutdown must not wait for the parent delivery lock"
        );
        assert_eq!(
            stopped.unwrap().unwrap().unwrap().status,
            crate::workspace_tasks::TaskStatus::Completed
        );
        let retained = outbox.read("owner", pending.operation_id).unwrap().unwrap();
        assert_eq!(retained.terminal.unwrap().outcome, Outcome::Succeeded);
        assert!(retained.receipt.is_none());
        assert_eq!(queue.load(&queue_scope).unwrap().items.len(), 1);

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "shutdown-before-launch",
            &serde_json::json!({"prompt":"Must not start"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let waiting = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = data.path().join("cancelled-launch-marker");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"")
            .arg("fixture")
            .arg(&marker);
        prepared.command = command;
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release_gate, release_gate_rx) = tokio::sync::oneshot::channel();
        let gate_manager = manager.clone();
        let gate_binding = waiting.clone();
        let gate = tokio::spawn(async move {
            gate_manager
                .with_bound_parent_launch(
                    &gate_binding.owner,
                    Path::new(&gate_binding.data_root),
                    &gate_binding.parent_session,
                    Path::new(&gate_binding.workspace),
                    gate_binding.queue_identity,
                    gate_binding.parent_incarnation,
                    &Cancellation::default(),
                    || async move {
                        entered.send(()).unwrap();
                        release_gate_rx.await.map_err(|_| "gate closed".to_string())
                    },
                )
                .await
        });
        entered_rx.await.unwrap();
        let shutdown = Cancellation::default();
        let (mut started, mut supervisor) = Arc::clone(&outbox).spawn_and_deliver(
            manager.clone(),
            waiting.clone(),
            prepared,
            Cancellation::default(),
            shutdown.clone(),
        );
        shutdown.cancel();
        let start_result =
            tokio::time::timeout(std::time::Duration::from_secs(2), &mut started).await;
        release_gate.send(()).unwrap();
        gate.await.unwrap().unwrap();
        let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), &mut supervisor)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            start_result.is_ok(),
            "Shutdown must release a child waiting for launch admission"
        );
        assert!(start_result.unwrap().unwrap().is_err());
        assert!(!marker.exists());
        assert_eq!(
            stopped.status,
            crate::workspace_tasks::TaskStatus::Interrupted
        );
        assert_eq!(
            outbox
                .read("owner", waiting.operation_id)
                .unwrap()
                .unwrap()
                .terminal
                .unwrap()
                .outcome,
            Outcome::Interrupted
        );

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "deleted-parent",
            &serde_json::json!({"prompt":"Inspect again"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let orphan = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let output = serde_json::json!({"type":"v4.result","sessionId":orphan.child_session,"text":"Late answer","is_error":false}).to_string();
        let release = data.path().join("release-child");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("while [ ! -f \"$2\" ]; do sleep 0.05; done; printf '%s\\n' \"$1\"")
            .arg("fixture")
            .arg(output)
            .arg(&release);
        prepared.command = command;
        let (started, supervisor) = Arc::clone(&outbox).spawn_and_deliver(
            manager.clone(),
            orphan.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        started.await.unwrap().unwrap();
        manager
            .delete_session("owner", &scope.session_id)
            .await
            .unwrap();
        std::fs::write(release, "release").unwrap();
        assert!(supervisor.await.unwrap().is_err());
        let retained = outbox.read("owner", orphan.operation_id).unwrap().unwrap();
        assert_eq!(retained.terminal.unwrap().outcome, Outcome::Succeeded);
        assert!(retained.receipt.is_none());

        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "missing-parent",
            &serde_json::json!({"prompt":"Do not run after deletion"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let rejected = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = data.path().join("must-not-start");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"")
            .arg("fixture")
            .arg(&marker);
        prepared.command = command;
        let (started, supervisor) = Arc::clone(&outbox).spawn_and_deliver(
            manager.clone(),
            rejected.clone(),
            prepared,
            Cancellation::default(),
            Cancellation::default(),
        );
        assert!(started.await.unwrap().is_err());
        assert!(supervisor.await.unwrap().is_err());
        assert!(!marker.exists());
        assert_eq!(
            outbox
                .read("owner", rejected.operation_id)
                .unwrap()
                .unwrap()
                .terminal
                .unwrap()
                .outcome,
            Outcome::Interrupted
        );
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn manager_deletion_stops_owned_child_and_retains_interrupted_outcome() {
        use crate::followup_queue::{QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use crate::v4_agent::interaction::{
            ActionScope, ApprovalRequest, Cancellation, Interaction,
        };
        use terminal_v4_core::{AppConfig, StructuredSessionEvent};
        struct Allow;
        #[async_trait::async_trait]
        impl Interaction for Allow {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<()> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool> {
                Ok(true)
            }
        }

        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().canonicalize().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        manager
            .bind_delegation_supervisor(Arc::clone(&supervisor))
            .unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut session = super::super::new_session("deepseek", "deepseek-chat", &workspace_path);
        session.id = crate::structured::engine_session_id(&parent.id).unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: parent.id,
            turn_id: Uuid::new_v4().to_string(),
        };
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let queue_scope = QueueScope::new("owner", &workspace_path, &scope.session_id).unwrap();
        queue.load(&queue_scope).unwrap();
        let queue_identity = queue
            .ensure_existing_identity(&queue_scope)
            .unwrap()
            .unwrap();
        let approved = super::super::delegation_review::review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "fixture",
            &serde_json::json!({"prompt":"Investigate"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let binding = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = data.path().join("child-running");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"; while :; do sleep 1; done")
            .arg("fixture")
            .arg(&marker);
        prepared.command = command;
        let started = supervisor
            .start(
                manager.clone(),
                binding.clone(),
                prepared,
                Cancellation::default(),
            )
            .unwrap();
        started.await.unwrap().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        supervisor.recover_ready(&manager, "owner").await.unwrap();
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                data.path().canonicalize().unwrap(),
                "owner".into(),
                Uuid::parse_str(&binding.task).unwrap(),
                Uuid::parse_str(&binding.child_session).unwrap(),
                binding.task_input(),
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Running
        );
        let other_parent = manager
            .create_session(
                "other",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut other_session =
            super::super::new_session("deepseek", "deepseek-chat", &workspace_path);
        other_session.id = crate::structured::engine_session_id(&other_parent.id).unwrap();
        let other_scope = ActionScope {
            owner: "other".into(),
            session_id: other_parent.id,
            turn_id: Uuid::new_v4().to_string(),
        };
        let other_queue_scope =
            QueueScope::new("other", &workspace_path, &other_scope.session_id).unwrap();
        queue.load(&other_queue_scope).unwrap();
        let other_identity = queue
            .ensure_existing_identity(&other_queue_scope)
            .unwrap()
            .unwrap();
        let other_approved = super::super::delegation_review::review(
            data.path(),
            "other",
            &other_session,
            &other_scope,
            other_identity,
            "other-fixture",
            &serde_json::json!({"prompt":"Other investigation"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let other_binding = other_approved.binding().clone();
        let (_, mut other_prepared) = outbox
            .prepare_authorized_held_child(data.path(), other_approved)
            .await
            .unwrap();
        let other_marker = data.path().join("other-child-running");
        let mut other_command = tokio::process::Command::new("/bin/sh");
        other_command
            .arg("-c")
            .arg("printf started > \"$1\"; while :; do sleep 1; done")
            .arg("fixture")
            .arg(&other_marker);
        other_prepared.command = other_command;
        supervisor
            .start(
                manager.clone(),
                other_binding.clone(),
                other_prepared,
                Cancellation::default(),
            )
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !other_marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            manager.delete_session("owner", &scope.session_id),
        )
        .await
        .unwrap()
        .unwrap();
        let record = outbox.read("owner", binding.operation_id).unwrap().unwrap();
        assert_eq!(record.terminal.unwrap().outcome, Outcome::Interrupted);
        assert!(record.receipt.is_none());
        assert!(manager
            .get_session("owner", &scope.session_id)
            .await
            .unwrap()
            .is_none());
        let other_status = crate::workspace_tasks::delegated_task_status(
            data.path().canonicalize().unwrap(),
            "other".into(),
            Uuid::parse_str(&other_binding.task).unwrap(),
            Uuid::parse_str(&other_binding.child_session).unwrap(),
            other_binding.task_input(),
        )
        .await
        .unwrap();
        assert_eq!(other_status, crate::workspace_tasks::TaskStatus::Running);
        manager.close_owner("other").await.unwrap();
        let other = outbox
            .read("other", other_binding.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(other.terminal.unwrap().outcome, Outcome::Interrupted);
        assert!(other.receipt.is_none());

        let approved = super::super::delegation_review::review(
            data.path(),
            "other",
            &other_session,
            &other_scope,
            other_identity,
            "after-owner-cleanup",
            &serde_json::json!({"prompt":"Investigate again"}),
            &Allow,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let last = approved.binding().clone();
        let (_, mut prepared) = outbox
            .prepare_authorized_held_child(data.path(), approved)
            .await
            .unwrap();
        let marker = data.path().join("last-child-running");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"; while :; do sleep 1; done")
            .arg("fixture")
            .arg(&marker);
        prepared.command = command;
        supervisor
            .start(
                manager.clone(),
                last.clone(),
                prepared,
                Cancellation::default(),
            )
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        manager.shutdown().await.unwrap();
        let record = outbox.read("other", last.operation_id).unwrap().unwrap();
        assert_eq!(record.terminal.unwrap().outcome, Outcome::Interrupted);
        assert!(record.receipt.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_delivers_staged_results_once_and_does_not_repeat_uncertain_attempts() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use terminal_v4_core::AppConfig;

        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().canonicalize().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let first = StructuredSessionManager::new(config.clone());
        first.bind_live_ownership().unwrap();
        first
            .bind_delegation_supervisor(Arc::new(
                DelegationSupervisor::new(Arc::clone(&outbox)).unwrap(),
            ))
            .unwrap();
        let parent = first
            .create_session(
                "owner",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&first),
        );
        let scope = QueueScope::new("owner", &workspace_path, &parent.id).unwrap();
        queue.load(&scope).unwrap();
        let identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        let mut binding = binding();
        binding.data_root = data.path().canonicalize().unwrap().to_str().unwrap().into();
        binding.parent_session = parent.id.clone();
        binding.parent_incarnation = first
            .session_incarnation_for_test("owner", &parent.id)
            .await;
        binding.child_session = Uuid::new_v4().to_string();
        binding.task = Uuid::new_v4().to_string();
        binding.queue_identity = identity;
        binding.workspace = workspace_path.to_str().unwrap().into();
        binding.provider = "deepseek".into();
        let stage = |binding: &Binding| {
            outbox.admit(binding).unwrap();
            let result = "No answer was returned.".to_string();
            outbox
                .finish(
                    "owner",
                    binding.operation_id,
                    &Terminal {
                        outcome: Outcome::Interrupted,
                        result: result.clone(),
                        source_digest: None,
                        mutation: Mutation {
                            operation_id: binding.operation_id,
                            expected_queue_revision: 0,
                            operation: QueueOperation::Enqueue {
                                item_id: binding.operation_id,
                                text: format!(
                                    "Delegated task {} (interrupted):\n{result}",
                                    binding.task
                                ),
                                run_when_idle: false,
                            },
                        },
                    },
                )
                .unwrap();
        };
        stage(&binding);
        let mut uncertain = binding.clone();
        uncertain.operation_id = Uuid::new_v4();
        uncertain.task = Uuid::new_v4().to_string();
        uncertain.child_session = Uuid::new_v4().to_string();
        stage(&uncertain);
        outbox
            .bind_first_delivery("owner", uncertain.operation_id, 0)
            .unwrap();
        let mut unstaged = binding.clone();
        unstaged.operation_id = Uuid::new_v4();
        unstaged.task = Uuid::new_v4().to_string();
        unstaged.child_session = Uuid::new_v4().to_string();
        outbox.admit(&unstaged).unwrap();
        let task_id = Uuid::parse_str(&unstaged.task).unwrap();
        let child_id = Uuid::parse_str(&unstaged.child_session).unwrap();
        crate::workspace_tasks::admit_held_delegation(
            data.path().canonicalize().unwrap(),
            "owner".into(),
            unstaged.task_input(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        crate::workspace_tasks::settle_held_delegation_for_test(
            data.path().canonicalize().unwrap(),
            "owner".into(),
            task_id,
            child_id,
            crate::workspace_tasks::TaskStatus::Interrupted,
            String::new(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(outbox
            .read("owner", unstaged.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_none());
        first.shutdown().await.unwrap();
        drop(queue);
        drop(first);
        drop(outbox);

        let outbox = Arc::new(Outbox::open(&data.path().join("outbox")).unwrap());
        let second = StructuredSessionManager::new(config);
        second.bind_live_ownership().unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        second
            .bind_delegation_supervisor(Arc::clone(&supervisor))
            .unwrap();
        supervisor.stop_owner("owner").await.unwrap();
        assert!(second
            .get_session("owner", &parent.id)
            .await
            .unwrap()
            .is_some());
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
        supervisor.resume_owner("owner").unwrap();
        assert!(second
            .get_session("owner", &parent.id)
            .await
            .unwrap()
            .is_some());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while outbox
                .read("owner", binding.operation_id)
                .unwrap()
                .unwrap()
                .receipt
                .is_none()
                || outbox
                    .read("owner", unstaged.operation_id)
                    .unwrap()
                    .unwrap()
                    .receipt
                    .is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&second),
        );
        let snapshot = queue.load(&scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason, snapshot.items.len()),
            (QueueMode::Held, Some(HoldReason::Restart), 2)
        );
        assert!(snapshot
            .items
            .iter()
            .any(|item| item.text.contains(&binding.task)));
        assert!(snapshot
            .items
            .iter()
            .any(|item| item.text.contains(&unstaged.task)));
        assert!(outbox
            .read("owner", uncertain.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
        assert!(second
            .get_session("owner", &parent.id)
            .await
            .unwrap()
            .is_some());
        assert_eq!(queue.load(&scope).unwrap().items.len(), 2);
        second.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unclean_child_recovery_waits_for_owner_review_and_preserves_restart_hold() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use axum::{body::Body, http::Request, Extension};
        use http_body_util::BodyExt;
        use terminal_v4_core::AppConfig;
        use tower::ServiceExt;

        let (data, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        let workspace_path = workspace.path().canonicalize().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let first = StructuredSessionManager::new(config.clone());
        first.bind_live_ownership().unwrap();
        first
            .bind_delegation_supervisor(Arc::new(
                DelegationSupervisor::new(Arc::clone(&outbox)).unwrap(),
            ))
            .unwrap();
        let parent = first
            .create_session(
                "owner",
                workspace_path.to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&first),
        );
        let scope = QueueScope::new("owner", &workspace_path, &parent.id).unwrap();
        queue.load(&scope).unwrap();
        let identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        let mut binding = binding();
        binding.data_root = data.path().canonicalize().unwrap().to_str().unwrap().into();
        binding.parent_session = parent.id.clone();
        binding.parent_incarnation = first
            .session_incarnation_for_test("owner", &parent.id)
            .await;
        binding.child_session = Uuid::new_v4().to_string();
        binding.task = Uuid::new_v4().to_string();
        binding.queue_identity = identity;
        binding.workspace = workspace_path.to_str().unwrap().into();
        binding.provider = "deepseek".into();
        outbox.admit(&binding).unwrap();
        let task_id = Uuid::parse_str(&binding.task).unwrap();
        let child_id = Uuid::parse_str(&binding.child_session).unwrap();
        let root = data.path().canonicalize().unwrap();
        crate::workspace_tasks::admit_held_delegation(
            root.clone(),
            "owner".into(),
            binding.task_input(),
            task_id,
            child_id,
        )
        .await
        .unwrap();
        crate::workspace_tasks::launch_held_delegation(
            root.clone(),
            "owner".into(),
            task_id,
            child_id,
            binding.task_input(),
            || Ok(()),
        )
        .await
        .unwrap();
        drop(queue);
        drop(first);
        drop(outbox);

        let outbox = Arc::new(Outbox::open(&data.path().join("outbox")).unwrap());
        let second = StructuredSessionManager::new(config.clone());
        second.bind_live_ownership().unwrap();
        second
            .bind_delegation_supervisor(Arc::new(
                DelegationSupervisor::new(Arc::clone(&outbox)).unwrap(),
            ))
            .unwrap();
        assert!(second.get_session("owner", &parent.id).await.is_err());
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                root.clone(),
                "owner".into(),
                task_id,
                child_id,
                binding.task_input()
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Running
        );
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_none());

        let state =
            crate::state::AppState::new_with_services(config, None, second.clone()).unwrap();
        let app = crate::structured::ownership_recovery::routes()
            .layer(Extension(crate::auth::AuthenticatedUser {
                user_id: "owner".into(),
                username: "owner".into(),
            }))
            .with_state(state);
        let status = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/structured/ownership")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&status.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["state"], "unconfirmed");
        let review = app.oneshot(Request::builder().method("POST").uri("/api/structured/ownership/reconcile")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::json!({"epoch":value["epoch"], "operationId":Uuid::new_v4(), "acknowledged":true}).to_string())).unwrap()).await.unwrap();
        assert_eq!(review.status(), axum::http::StatusCode::NO_CONTENT);
        assert!(second
            .get_session("owner", &parent.id)
            .await
            .unwrap()
            .is_some());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while outbox
                .read("owner", binding.operation_id)
                .unwrap()
                .unwrap()
                .receipt
                .is_none()
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let task = crate::workspace_tasks::delegated_task_status(
            root,
            "owner".into(),
            task_id,
            child_id,
            binding.task_input(),
        )
        .await
        .unwrap();
        assert_eq!(task, crate::workspace_tasks::TaskStatus::Interrupted);
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&second),
        );
        let snapshot = queue.load(&scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason, snapshot.items.len()),
            (QueueMode::Held, Some(HoldReason::Restart), 1)
        );
        assert!(snapshot.items[0].text.contains("interrupted"));
        second.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn child_pipe_drains_after_its_retention_limit() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(1024);
        let task = tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 300_000]).await.unwrap();
        });
        let (output, truncated) = read_child_pipe(reader, 256 * 1024).await.unwrap();
        task.await.unwrap();
        assert_eq!((output.len(), truncated), (256 * 1024, true));
    }

    #[test]
    fn prepared_child_is_bound_to_one_durable_admission_and_never_replayed() {
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let command = outbox.prepare_read_only_child(dir.path(), &b).unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for (flag, value) in [
            ("--owner-hex", hex::encode(b.owner.as_bytes())),
            ("--provider", b.provider.clone()),
            ("--model", b.model.clone()),
            ("--query", b.prompt.clone()),
            ("--tool-policy", "read-only-child".into()),
            ("--child-session", b.child_session.clone()),
        ] {
            assert!(args
                .windows(2)
                .any(|pair| pair[0] == flag && pair[1] == value));
        }
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(Path::new(&b.workspace))
        );
        assert_eq!(
            outbox
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            b
        );
        assert!(outbox.prepare_read_only_child(dir.path(), &b).is_err());
        let mut changed = b.clone();
        changed.prompt.push('!');
        assert!(outbox
            .prepare_read_only_child(dir.path(), &changed)
            .is_err());
        drop(outbox);
        let reopened = reopen(&dir.path().join("outbox"));
        assert!(reopened.prepare_read_only_child(dir.path(), &b).is_err());
        assert_eq!(
            reopened
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            b
        );
        drop(reopened);
        let other_data =
            tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        std::fs::rename(dir.path().join("outbox"), other_data.path().join("outbox")).unwrap();
        let relocated = reopen(&other_data.path().join("outbox"));
        let mut another = b.clone();
        another.operation_id = Uuid::new_v4();
        another.child_session = Uuid::new_v4().to_string();
        another.task = Uuid::new_v4().to_string();
        assert!(relocated
            .prepare_read_only_child(other_data.path(), &another)
            .is_err());
    }

    #[test]
    fn invalid_child_binding_is_not_admitted() {
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let mut bad = b.clone();
        bad.child_session = "not-a-uuid".into();
        assert!(outbox.prepare_read_only_child(dir.path(), &bad).is_err());
        bad = b.clone();
        bad.provider = "codex".into();
        assert!(outbox.prepare_read_only_child(dir.path(), &bad).is_err());
        bad = b.clone();
        bad.workspace = dir.path().join("missing").to_string_lossy().into_owned();
        assert!(outbox.prepare_read_only_child(dir.path(), &bad).is_err());
        let other_data = tempfile::tempdir().unwrap();
        assert!(outbox
            .prepare_read_only_child(other_data.path(), &b)
            .is_err());
        assert!(outbox.read(&b.owner, b.operation_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn held_task_and_command_share_the_durable_child_binding() {
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let (task, command) = outbox.prepare_held_child(dir.path(), &b).await.unwrap();
        assert_eq!(task.id.to_string(), b.task);
        assert_eq!(
            task.status,
            crate::workspace_tasks::TaskStatus::DelegationHeld
        );
        assert_eq!(task.input.workspace_path, b.workspace);
        assert_eq!(
            task.input.parent_session_id.as_deref(),
            Some(b.parent_session.as_str())
        );
        assert_eq!(task.input.provider, b.provider);
        assert_eq!(task.input.model.as_deref(), Some(b.model.as_str()));
        assert_eq!(task.input.prompt, b.prompt);
        assert!(command
            .as_std()
            .get_args()
            .any(|arg| arg == b.child_session.as_str()));
        assert!(outbox.prepare_held_child(dir.path(), &b).await.is_err());
    }

    #[tokio::test]
    async fn terminal_task_conversion_preserves_identity_status_and_redaction() {
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let (mut task, _) = outbox.prepare_held_child(dir.path(), &b).await.unwrap();
        assert!(terminal_from_task(&b, &task, 4).is_err());
        task.status = crate::workspace_tasks::TaskStatus::Completed;
        task.completed_at = Some(100);
        task.result = "Finding\npassword=secret".into();
        let terminal = terminal_from_task(&b, &task, 4).unwrap();
        assert_eq!(terminal.outcome, Outcome::Succeeded);
        assert!(!terminal.result.contains("secret"));
        assert!(terminal.result.contains("Finding"));
        let QueueOperation::Enqueue {
            item_id,
            text,
            run_when_idle,
        } = &terminal.mutation.operation
        else {
            panic!("Expected enqueue")
        };
        assert_eq!(
            (
                *item_id,
                *run_when_idle,
                terminal.mutation.operation_id,
                terminal.mutation.expected_queue_revision
            ),
            (b.operation_id, false, b.operation_id, 4)
        );
        assert!(text.contains(&b.task));
        assert!(text.contains(&terminal.result));
        let mut changed = task.clone();
        changed.input.prompt.push('!');
        assert!(terminal_from_task(&b, &changed, 4).is_err());
        changed = task.clone();
        changed.input.parent_session_id = Some(format!("ss-{}", Uuid::new_v4().simple()));
        assert!(terminal_from_task(&b, &changed, 4).is_err());
        changed = task.clone();
        changed.id = Uuid::new_v4();
        assert!(terminal_from_task(&b, &changed, 4).is_err());
        changed = task.clone();
        changed.child_session_id = Some(Uuid::new_v4());
        assert!(terminal_from_task(&b, &changed, 4).is_err());
        changed = task.clone();
        changed.completed_at = None;
        assert!(terminal_from_task(&b, &changed, 4).is_err());
        changed = task.clone();
        changed.status = crate::workspace_tasks::TaskStatus::Failed;
        changed.result.clear();
        changed.error = Some("Provider could not complete the task".into());
        let failure = terminal_from_task(&b, &changed, 4).unwrap();
        assert_eq!(
            (failure.outcome, failure.result.as_str()),
            (Outcome::Failed, "No answer was returned.")
        );
        changed.status = crate::workspace_tasks::TaskStatus::Cancelled;
        assert_eq!(
            terminal_from_task(&b, &changed, 4).unwrap().outcome,
            Outcome::Cancelled
        );
        changed = task.clone();
        changed.status = crate::workspace_tasks::TaskStatus::Interrupted;
        assert_eq!(
            serde_json::to_value(terminal_from_task(&b, &changed, 4).unwrap().outcome).unwrap(),
            "interrupted"
        );
        changed = task.clone();
        changed.result = "é".repeat(25_001);
        let truncated = terminal_from_task(&b, &changed, 4).unwrap();
        assert!(truncated.result.ends_with("\n[Result truncated]"));
        assert!(truncated.result.len() < MAX_RESULT_BYTES);
        assert!(terminal_from_task(&b, &task, u64::MAX).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unowned_parent_cannot_receive_a_delegated_result() {
        use crate::followup_queue::{QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use terminal_v4_core::AppConfig;
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        });
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let scope = QueueScope::new("owner", workspace.path(), &parent.id).unwrap();
        let queue = QueueStore::new(dir.path(), crate::structured::queue::boot_id());
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        let mut b = binding();
        b.parent_session = parent.id;
        b.parent_incarnation = manager
            .session_incarnation_for_test("owner", &b.parent_session)
            .await;
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        outbox.admit(&b).unwrap();
        let result = "No answer was returned.".to_string();
        outbox
            .finish(
                "owner",
                b.operation_id,
                &Terminal {
                    outcome: Outcome::Cancelled,
                    result: result.clone(),
                    source_digest: None,
                    mutation: Mutation {
                        operation_id: b.operation_id,
                        expected_queue_revision: 0,
                        operation: QueueOperation::Enqueue {
                            item_id: b.operation_id,
                            text: format!("Delegated task {} (cancelled):\n{result}", b.task),
                            run_when_idle: false,
                        },
                    },
                },
            )
            .unwrap();
        let before = queue.load(&scope).unwrap();
        assert!(outbox
            .deliver_bound_parent(&manager, "owner", b.operation_id)
            .await
            .is_err());
        let after = queue.load(&scope).unwrap();
        assert_eq!(
            (after.revision, after.items.len()),
            (before.revision, before.items.len())
        );
        assert!(outbox
            .read("owner", b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
        let terminal = outbox
            .bind_first_delivery("owner", b.operation_id, after.revision)
            .unwrap();
        queue
            .mutate_existing_with_identity(&scope, b.queue_identity, terminal.mutation)
            .unwrap();
        assert!(
            outbox
                .reconcile_existing_receipt(&manager, "owner", b.operation_id)
                .await
                .is_err(),
            "Unowned parent must not acknowledge a delivery receipt"
        );
        assert!(outbox
            .read("owner", b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn delegated_delivery_binds_parent_incarnation_and_owner_authority() {
        use crate::followup_queue::{HoldReason, IdleBoundary, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use terminal_v4_core::AppConfig;

        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        };
        let app = crate::state::AppState::new(config.clone()).unwrap();
        let manager = StructuredSessionManager::new(config);
        manager.bind_live_ownership().unwrap();
        manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        crate::vault::VaultCipher::load(dir.path()).unwrap();

        for case in [
            "authorized",
            "unproven",
            "revoked",
            "expired",
            "changed",
            "legacy",
        ] {
            let parent = manager
                .create_session(
                    "owner",
                    workspace.path().to_str().unwrap(),
                    Some("deepseek"),
                    None,
                    None,
                )
                .await
                .unwrap();
            let incarnation = manager
                .session_incarnation_for_test("owner", &parent.id)
                .await
                .unwrap();
            let scope = QueueScope::new("owner", workspace.path(), &parent.id).unwrap();
            let queue = QueueStore::new(
                dir.path(),
                crate::structured::queue::manager_boot_id(&manager),
            );
            let initial = queue.load(&scope).unwrap();
            if case == "unproven" {
                queue
                    .mutate(
                        &scope,
                        Mutation {
                            operation_id: Uuid::new_v4(),
                            expected_queue_revision: initial.revision,
                            operation: QueueOperation::Resume,
                        },
                    )
                    .unwrap();
            }
            let mut b = binding();
            b.parent_session = parent.id;
            b.parent_incarnation = match case {
                "legacy" => None,
                "changed" => Some(Uuid::new_v4()),
                _ => Some(incarnation),
            };
            b.data_root = dir
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            b.workspace = workspace
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            b.child_session = Uuid::new_v4().to_string();
            b.task = Uuid::new_v4().to_string();
            b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
            b.authorization = match case {
                "authorized" | "revoked" | "expired" => Some(DelegationAuthorization {
                    session_incarnation: incarnation,
                    generation: i64::from(case == "revoked"),
                    expires_at_ms: super::super::interaction::now_ms()
                        + if case == "expired" { -1 } else { 60_000 },
                }),
                _ => None,
            };
            outbox.admit(&b).unwrap();
            let result = "No answer was returned.".to_string();
            outbox
                .finish(
                    "owner",
                    b.operation_id,
                    &Terminal {
                        outcome: Outcome::Cancelled,
                        result: result.clone(),
                        source_digest: None,
                        mutation: Mutation {
                            operation_id: b.operation_id,
                            expected_queue_revision: 0,
                            operation: QueueOperation::Enqueue {
                                item_id: b.operation_id,
                                text: format!("Delegated task {} (cancelled):\n{result}", b.task),
                                run_when_idle: false,
                            },
                        },
                    },
                )
                .unwrap();
            let delivery = outbox
                .deliver_bound_parent(&manager, "owner", b.operation_id)
                .await;
            let snapshot = queue.load(&scope).unwrap();
            if matches!(case, "revoked" | "expired" | "changed" | "legacy") {
                assert!(delivery.is_err(), "{case} must remain staged");
                assert!(snapshot.items.is_empty());
                assert!(outbox
                    .read("owner", b.operation_id)
                    .unwrap()
                    .unwrap()
                    .receipt
                    .is_none());
                continue;
            }
            delivery.unwrap();
            assert_eq!(snapshot.items.len(), 1);
            if case == "unproven" {
                assert_eq!(
                    (snapshot.mode, snapshot.hold_reason),
                    (QueueMode::Held, Some(HoldReason::DispatchError))
                );
            } else {
                queue
                    .mutate(
                        &scope,
                        Mutation {
                            operation_id: Uuid::new_v4(),
                            expected_queue_revision: snapshot.revision,
                            operation: QueueOperation::Resume,
                        },
                    )
                    .unwrap();
                let ready = queue.load(&scope).unwrap();
                let reservation = queue
                    .reserve_next(&scope, ready.revision, IdleBoundary { turn_epoch: 1 })
                    .unwrap()
                    .unwrap();
                assert!(queue
                    .verify_reservation_authority(&scope, incarnation, &reservation)
                    .unwrap()
                    .is_some());
                assert!(queue
                    .verify_reservation_authority(&scope, Uuid::new_v4(), &reservation)
                    .is_err());
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn parent_gated_delivery_binds_the_latest_revision_and_preserves_manual_hold() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use terminal_v4_core::AppConfig;
        let (dir, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(dir.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let competing = StructuredSessionManager::new(AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        });
        competing.bind_live_ownership().unwrap();
        assert!(competing.get_session("owner", &parent.id).await.is_err());
        let mut b = binding();
        b.parent_session = parent.id;
        b.parent_incarnation = manager
            .session_incarnation_for_test("owner", &b.parent_session)
            .await;
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let queue = QueueStore::new(
            dir.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let scope = QueueScope::new(&b.owner, workspace.path(), &b.parent_session).unwrap();
        let paused = queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        outbox.admit(&b).unwrap();
        let result = "No answer was returned.".to_string();
        outbox
            .finish(
                &b.owner,
                b.operation_id,
                &Terminal {
                    outcome: Outcome::Cancelled,
                    result: result.clone(),
                    source_digest: None,
                    mutation: Mutation {
                        operation_id: b.operation_id,
                        expected_queue_revision: paused.queue_revision,
                        operation: QueueOperation::Enqueue {
                            item_id: b.operation_id,
                            text: format!("Delegated task {} (cancelled):\n{result}", b.task),
                            run_when_idle: false,
                        },
                    },
                },
            )
            .unwrap();
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: paused.queue_revision,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "User follow-up".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        outbox
            .deliver_bound_parent(&manager, "owner", b.operation_id)
            .await
            .unwrap();
        outbox
            .deliver_bound_parent(&manager, "owner", b.operation_id)
            .await
            .unwrap();
        let snapshot = queue.load(&scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason, snapshot.items.len()),
            (QueueMode::Held, Some(HoldReason::Manual), 2)
        );
        assert_eq!(snapshot.items[0].text, "User follow-up");
        assert!(snapshot.items[1].text.contains("Delegated task"));
        let record = outbox.read("owner", b.operation_id).unwrap().unwrap();
        assert_eq!(
            record.terminal.unwrap().mutation.expected_queue_revision,
            paused.queue_revision + 1
        );
        assert!(record.receipt.is_some());

        let stage_cancelled = |binding: &Binding| {
            outbox.admit(binding).unwrap();
            let result = "No answer was returned.".to_string();
            outbox
                .finish(
                    &binding.owner,
                    binding.operation_id,
                    &Terminal {
                        outcome: Outcome::Cancelled,
                        result: result.clone(),
                        source_digest: None,
                        mutation: Mutation {
                            operation_id: binding.operation_id,
                            expected_queue_revision: 0,
                            operation: QueueOperation::Enqueue {
                                item_id: binding.operation_id,
                                text: format!(
                                    "Delegated task {} (cancelled):\n{result}",
                                    binding.task
                                ),
                                run_when_idle: false,
                            },
                        },
                    },
                )
                .unwrap();
        };
        let mut uncertain = b.clone();
        uncertain.operation_id = Uuid::new_v4();
        uncertain.task = Uuid::new_v4().to_string();
        uncertain.child_session = Uuid::new_v4().to_string();
        stage_cancelled(&uncertain);
        let revision = queue.load(&scope).unwrap().revision;
        assert!(outbox
            .deliver_bound_parent_with(&manager, "owner", uncertain.operation_id, |_, _, _, _| Err(
                "simulated unknown submission".into()
            ))
            .await
            .is_err());
        assert_eq!(
            outbox
                .read("owner", uncertain.operation_id)
                .unwrap()
                .unwrap()
                .terminal
                .unwrap()
                .mutation
                .expected_queue_revision,
            revision
        );
        queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: revision,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "Later message".into(),
                        run_when_idle: false,
                    },
                },
            )
            .unwrap();
        assert!(outbox
            .deliver_bound_parent(&manager, "owner", uncertain.operation_id)
            .await
            .is_err());
        assert_eq!(
            outbox
                .read("owner", uncertain.operation_id)
                .unwrap()
                .unwrap()
                .terminal
                .unwrap()
                .mutation
                .expected_queue_revision,
            revision
        );
        assert_eq!(queue.load(&scope).unwrap().items.len(), 3);

        let mut lost_ack = b.clone();
        lost_ack.operation_id = Uuid::new_v4();
        lost_ack.task = Uuid::new_v4().to_string();
        lost_ack.child_session = Uuid::new_v4().to_string();
        stage_cancelled(&lost_ack);
        assert!(outbox
            .deliver_bound_parent_with(
                &manager,
                "owner",
                lost_ack.operation_id,
                |queue, scope, identity, mutation| {
                    queue
                        .mutate_existing_with_identity(scope, identity, mutation)
                        .map_err(|error| format!("{error:?}"))?;
                    Err("simulated lost acknowledgement".into())
                }
            )
            .await
            .is_err());
        assert_eq!(queue.load(&scope).unwrap().items.len(), 4);
        outbox
            .deliver_bound_parent(&manager, "owner", lost_ack.operation_id)
            .await
            .unwrap();
        assert_eq!(queue.load(&scope).unwrap().items.len(), 4);
        assert!(outbox
            .read("owner", lost_ack.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_some());

        let restarted = QueueStore::new(dir.path(), Uuid::new_v4());
        assert_eq!(
            restarted.load(&scope).unwrap().hold_reason,
            Some(HoldReason::Restart)
        );
        let mut after_restart = b.clone();
        after_restart.operation_id = Uuid::new_v4();
        after_restart.task = Uuid::new_v4().to_string();
        after_restart.child_session = Uuid::new_v4().to_string();
        stage_cancelled(&after_restart);
        outbox
            .deliver_bound_parent(&manager, "owner", after_restart.operation_id)
            .await
            .unwrap();
        let snapshot = queue.load(&scope).unwrap();
        assert_eq!(
            (snapshot.mode, snapshot.hold_reason, snapshot.items.len()),
            (QueueMode::Held, Some(HoldReason::Restart), 5)
        );

        let mut racing = b.clone();
        racing.operation_id = Uuid::new_v4();
        racing.task = Uuid::new_v4().to_string();
        racing.child_session = Uuid::new_v4().to_string();
        stage_cancelled(&racing);
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let delivery = {
            let manager = manager.clone();
            let outbox = Arc::clone(&outbox);
            let operation = racing.operation_id;
            tokio::spawn(async move {
                outbox
                    .deliver_bound_parent_with(
                        &manager,
                        "owner",
                        operation,
                        move |queue, scope, identity, mutation| {
                            entered.send(()).unwrap();
                            wait_release.recv().unwrap();
                            queue
                                .mutate_existing_with_identity(scope, identity, mutation)
                                .map_err(|error| format!("{error:?}"))
                        },
                    )
                    .await
            })
        };
        wait_entered.await.unwrap();
        let mut deletion = {
            let manager = manager.clone();
            let session_id = b.parent_session.clone();
            tokio::spawn(async move { manager.delete_session("owner", &session_id).await })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut deletion)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        delivery.await.unwrap().unwrap();
        deletion.await.unwrap().unwrap();
        assert!(outbox
            .deliver_bound_parent(&manager, "owner", racing.operation_id)
            .await
            .is_err());
        assert!(manager
            .get_session("owner", &b.parent_session)
            .await
            .unwrap()
            .is_none());
        assert!(outbox
            .read("owner", racing.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_some());
    }

    #[tokio::test]
    async fn durable_task_result_is_staged_once_and_survives_task_removal() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use sha2::{Digest, Sha256};
        use std::io::Write;
        use terminal_v4_core::AppConfig;
        let (dir, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(dir.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut b = binding();
        b.parent_session = parent.id;
        b.parent_incarnation = manager
            .session_incarnation_for_test("owner", &b.parent_session)
            .await;
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        let queue = QueueStore::new(
            dir.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let scope = QueueScope::new(&b.owner, workspace.path(), &b.parent_session).unwrap();
        let pause = queue
            .mutate(
                &scope,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Pause,
                },
            )
            .unwrap();
        b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        outbox.prepare_held_child(dir.path(), &b).await.unwrap();
        assert_eq!(
            outbox
                .stage_persisted_task_result(&b.owner, b.operation_id, 0)
                .await
                .unwrap(),
            None
        );
        assert!(outbox
            .stage_persisted_task_result("foreign", b.operation_id, 0)
            .await
            .is_err());

        let directory = dir.path().join("workspace-tasks");
        let path = directory.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b.owner.as_bytes()))
        ));
        let mut store: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let task = &mut store["tasks"][0];
        task["status"] = serde_json::json!("completed");
        task["completedAt"] = serde_json::json!(100);
        task["exitCode"] = serde_json::json!(0);
        task["result"] = serde_json::json!("Found the answer");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&serde_json::to_vec(&store).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        std::fs::File::open(&directory).unwrap().sync_all().unwrap();

        assert!(outbox
            .stage_persisted_task_result(&b.owner, b.operation_id, 0)
            .await
            .is_err());
        let result = serde_json::json!({"type":"v4.result", "sessionId":b.child_session, "text":"Found the answer", "is_error":false});
        outbox
            .record_verified_child_output(
                &b.owner,
                b.operation_id,
                format!("{result}\n").as_bytes(),
                false,
                Some(0),
            )
            .unwrap();
        outbox
            .record_verified_child_output(
                &b.owner,
                b.operation_id,
                format!("{result}\n").as_bytes(),
                false,
                Some(0),
            )
            .unwrap();
        let conflicting = serde_json::json!({"type":"v4.result", "sessionId":b.child_session, "text":"Different answer", "is_error":false});
        assert!(outbox
            .record_verified_child_output(
                &b.owner,
                b.operation_id,
                format!("{conflicting}\n").as_bytes(),
                false,
                Some(0)
            )
            .is_err());

        let terminal = outbox
            .stage_persisted_task_result(&b.owner, b.operation_id, pause.queue_revision)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (terminal.outcome.clone(), terminal.result.as_str()),
            (Outcome::Succeeded, "Found the answer")
        );
        let record = outbox.read(&b.owner, b.operation_id).unwrap().unwrap();
        let mut altered = terminal.clone();
        altered.result = "An unrelated answer".into();
        if let QueueOperation::Enqueue { text, .. } = &mut altered.mutation.operation {
            *text = format!("Delegated task {} (completed):\n{}", b.task, altered.result);
        }
        assert!(validate_staged_terminal(&record, &altered).is_err());
        assert_eq!(
            outbox
                .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
                .await
                .unwrap(),
            None
        );
        let actor = queue.clone();
        let actor_scope = scope.clone();
        assert_eq!(
            outbox
                .deliver_with_exclusive_parent(
                    &manager,
                    &b.owner,
                    b.operation_id,
                    move |binding, mutation| async move {
                        actor
                            .mutate_existing_with_identity(
                                &actor_scope,
                                binding.queue_identity,
                                mutation,
                            )
                            .map_err(|e| format!("{e:?}"))?;
                        Err("simulated lost acknowledgement".into())
                    }
                )
                .await
                .unwrap(),
            Some(())
        );
        let receipt = outbox
            .read(&b.owner, b.operation_id)
            .unwrap()
            .unwrap()
            .receipt;
        assert!(receipt.is_some());
        assert_eq!(
            outbox
                .deliver_with_exclusive_parent(&manager, &b.owner, b.operation_id, |_, _| async {
                    panic!("committed result must not be submitted again")
                })
                .await
                .unwrap(),
            Some(())
        );
        let held = queue.load(&scope).unwrap();
        assert_eq!(
            (held.mode, held.hold_reason),
            (QueueMode::Held, Some(HoldReason::Manual))
        );
        let mut altered_mutation = terminal.mutation.clone();
        if let QueueOperation::Enqueue { text, .. } = &mut altered_mutation.operation {
            text.push_str(" changed");
        }
        assert!(queue
            .mutate_existing_with_identity(&scope, b.queue_identity, altered_mutation)
            .is_err());
        assert_eq!(
            outbox
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .terminal,
            Some(terminal.clone())
        );
        store["tasks"] = serde_json::json!([]);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&serde_json::to_vec(&store).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        drop(outbox);
        let outbox = Arc::new(reopen(&dir.path().join("outbox")));
        assert_eq!(
            outbox
                .stage_persisted_task_result(&b.owner, b.operation_id, 9)
                .await
                .unwrap(),
            Some(terminal)
        );
        let restarted = QueueStore::new(dir.path(), Uuid::new_v4());
        let held = restarted.load(&scope).unwrap();
        assert_eq!(
            (held.mode, held.hold_reason),
            (QueueMode::Held, Some(HoldReason::Restart))
        );
        assert_eq!(
            outbox
                .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
                .await
                .unwrap(),
            Some(())
        );
        assert_eq!(
            restarted.load(&scope).unwrap().hold_reason,
            Some(HoldReason::Restart)
        );
    }

    #[tokio::test]
    async fn staged_success_requires_a_child_proof_even_after_a_terminal_record_exists() {
        let (dir, outbox) = store();
        let outbox = Arc::new(outbox);
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        outbox.admit(&b).unwrap();
        outbox
            .finish(&b.owner, b.operation_id, &terminal(&b))
            .unwrap();
        assert!(outbox
            .stage_persisted_task_result(&b.owner, b.operation_id, 0)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn uncertain_delivery_is_not_replayed_after_outbox_restart() {
        use crate::followup_queue::{QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use sha2::{Digest, Sha256};
        use terminal_v4_core::AppConfig;
        let (data, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut b = binding();
        b.parent_session = parent.id;
        b.parent_incarnation = manager
            .session_incarnation_for_test("owner", &b.parent_session)
            .await;
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = data
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let scope = QueueScope::new(&b.owner, workspace.path(), &b.parent_session).unwrap();
        queue.load(&scope).unwrap();
        b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        outbox.admit(&b).unwrap();
        let terminal = Terminal {
            outcome: Outcome::Interrupted,
            result: "No answer was returned.".into(),
            source_digest: None,
            mutation: Mutation {
                operation_id: b.operation_id,
                expected_queue_revision: 0,
                operation: QueueOperation::Enqueue {
                    item_id: b.operation_id,
                    text: format!(
                        "Delegated task {} (interrupted):\nNo answer was returned.",
                        b.task
                    ),
                    run_when_idle: false,
                },
            },
        };
        outbox.finish(&b.owner, b.operation_id, &terminal).unwrap();
        assert!(outbox
            .deliver_with_exclusive_parent(&manager, &b.owner, b.operation_id, |_, _| async {
                Err("lost before receipt".into())
            })
            .await
            .is_err());
        drop(outbox);
        let outbox = reopen(&data.path().join("outbox"));
        assert!(outbox
            .deliver_with_exclusive_parent(&manager, &b.owner, b.operation_id, |_, _| async {
                panic!("uncertain operation must not be replayed")
            })
            .await
            .is_err());
        assert!(outbox
            .read(&b.owner, b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
        let queue_file = data
            .path()
            .join("followup-queues")
            .join(hex::encode(Sha256::digest(b.owner.as_bytes())))
            .join(hex::encode(Sha256::digest(b.workspace.as_bytes())))
            .join(format!("{}.json", b.parent_session));
        std::fs::remove_file(&queue_file).unwrap();
        queue.load(&scope).unwrap();
        let replacement = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        assert_ne!(replacement, b.queue_identity);
        assert!(outbox
            .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
            .await
            .is_err());
        assert!(outbox
            .deliver_with_exclusive_parent(&manager, &b.owner, b.operation_id, |_, _| async {
                panic!("replacement queue must never receive the old result")
            })
            .await
            .is_err());

        let mut next = b.clone();
        next.operation_id = Uuid::new_v4();
        next.task = Uuid::new_v4().to_string();
        next.child_session = Uuid::new_v4().to_string();
        next.queue_identity = replacement;
        outbox.admit(&next).unwrap();
        let next_terminal = Terminal {
            outcome: Outcome::Interrupted,
            result: "No answer was returned.".into(),
            source_digest: None,
            mutation: Mutation {
                operation_id: next.operation_id,
                expected_queue_revision: 0,
                operation: QueueOperation::Enqueue {
                    item_id: next.operation_id,
                    text: format!(
                        "Delegated task {} (interrupted):\nNo answer was returned.",
                        next.task
                    ),
                    run_when_idle: false,
                },
            },
        };
        outbox
            .finish(&next.owner, next.operation_id, &next_terminal)
            .unwrap();
        let actor = queue.clone();
        let actor_scope = scope.clone();
        assert!(outbox
            .deliver_with_exclusive_parent(
                &manager,
                &next.owner,
                next.operation_id,
                move |binding, mutation| async move {
                    std::fs::remove_file(&queue_file).unwrap();
                    actor.load(&actor_scope).unwrap();
                    actor.ensure_existing_identity(&actor_scope).unwrap();
                    actor
                        .mutate_existing_with_identity(
                            &actor_scope,
                            binding.queue_identity,
                            mutation,
                        )
                        .map(|_| ())
                        .map_err(|e| format!("{e:?}"))
                }
            )
            .await
            .is_err());
        assert!(queue.load(&scope).unwrap().items.is_empty());
    }

    #[test]
    fn child_output_requires_one_complete_result_for_the_approved_session() {
        let mut b = binding();
        b.child_session = Uuid::new_v4().to_string();
        let delta = serde_json::json!({"type":"v4.text.delta", "sessionId":b.child_session, "delta":"partial"}).to_string();
        let final_line = serde_json::json!({"type":"v4.result", "sessionId":b.child_session, "text":"answer", "is_error":false}).to_string();
        let stdout = format!("{delta}\n{final_line}\n");
        assert_eq!(
            verify_child_output(&b, stdout.as_bytes(), false, Some(0)).unwrap(),
            VerifiedChildResult {
                text: "answer".into(),
                is_error: false
            }
        );
        assert!(verify_child_output(&b, format!("{delta}\n").as_bytes(), false, Some(0)).is_err());
        assert!(verify_child_output(
            &b,
            format!("{final_line}\n{final_line}\n").as_bytes(),
            false,
            Some(0)
        )
        .is_err());
        assert!(verify_child_output(&b, stdout.as_bytes(), true, Some(0)).is_err());
        assert!(verify_child_output(&b, stdout.as_bytes(), false, Some(1)).is_err());
        assert!(verify_child_output(&b, stdout.as_bytes(), false, None).is_err());
        let foreign = serde_json::json!({"type":"v4.result", "sessionId":Uuid::new_v4().to_string(), "text":"answer", "is_error":false}).to_string();
        assert!(
            verify_child_output(&b, format!("{foreign}\n").as_bytes(), false, Some(0)).is_err()
        );
        let foreign_delta = serde_json::json!({"type":"v4.text.delta", "sessionId":Uuid::new_v4().to_string(), "delta":"partial"}).to_string();
        assert!(verify_child_output(
            &b,
            format!("{foreign_delta}\n{final_line}\n").as_bytes(),
            false,
            Some(0)
        )
        .is_err());
        assert!(verify_child_output(
            &b,
            format!("{final_line}\n{delta}\n").as_bytes(),
            false,
            Some(0)
        )
        .is_err());
        assert!(verify_child_output(&b, b"not-json\n", false, Some(0)).is_err());
        assert!(verify_child_output(&b, &[0xff, b'\n'], false, Some(0)).is_err());
        assert!(verify_child_output(&b, final_line.as_bytes(), false, Some(0)).is_err());
        let failure = serde_json::json!({"type":"v4.result", "sessionId":b.child_session, "text":"failure", "is_error":true}).to_string();
        assert_eq!(
            verify_child_output(&b, format!("{failure}\n").as_bytes(), false, Some(1)).unwrap(),
            VerifiedChildResult {
                text: "failure".into(),
                is_error: true
            }
        );
    }

    #[tokio::test]
    async fn failed_task_store_leaves_only_unlaunchable_outbox_admission() {
        let (dir, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        b.child_session = Uuid::new_v4().to_string();
        b.task = Uuid::new_v4().to_string();
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.provider = "deepseek".into();
        std::fs::write(dir.path().join("workspace-tasks"), b"not a directory").unwrap();
        assert!(outbox.prepare_held_child(dir.path(), &b).await.is_err());
        assert_eq!(
            outbox
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            b
        );
        assert!(outbox.prepare_held_child(dir.path(), &b).await.is_err());
        drop(outbox);
        let reopened = reopen(&dir.path().join("outbox"));
        assert!(reopened.prepare_held_child(dir.path(), &b).await.is_err());
    }
    fn reopen(path: &Path) -> Outbox {
        for _ in 0..100 {
            match Outbox::open(path) {
                Ok(store) => return store,
                Err(error) if error == "Outbox is already in use" => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("Cannot reopen outbox: {error}"),
            }
        }
        panic!("Outbox remained locked");
    }
    #[test]
    fn admission_is_idempotent_and_binding_is_immutable() {
        let (_dir, store) = store();
        let b = binding();
        assert_eq!(store.admit(&b).unwrap(), Admission::New);
        assert_eq!(store.admit(&b).unwrap(), Admission::Existing);
        let mut changed = b.clone();
        changed.child_session = "other".into();
        assert!(store.admit(&changed).is_err());
        changed = b.clone();
        changed.operation_id = Uuid::new_v4();
        assert!(store.admit(&changed).is_err());
        assert!(store.read("foreign", b.operation_id).unwrap().is_none());
        assert!(store.list("foreign").unwrap().is_empty());
        assert_eq!(store.list("owner").unwrap()[0].binding, b);
        let mut foreign = b.clone();
        foreign.owner = "foreign".into();
        assert_eq!(store.admit(&foreign).unwrap(), Admission::New);
        assert_eq!(store.list("foreign").unwrap()[0].binding, foreign);
    }

    #[cfg(unix)]
    #[test]
    fn parent_outstanding_is_scoped_and_fails_closed_on_changed_identity() {
        let (_dir, outbox) = store();
        let mut request = binding();
        let incarnation = Uuid::new_v4();
        request.parent_incarnation = Some(incarnation);
        outbox.admit(&request).unwrap();
        let supervisor = DelegationSupervisor::new(Arc::new(outbox)).unwrap();
        assert!(supervisor
            .parent_has_outstanding("owner", "parent", incarnation)
            .unwrap());
        assert!(supervisor
            .parent_has_outstanding("owner", "parent", Uuid::new_v4())
            .unwrap());
        assert!(!supervisor
            .parent_has_outstanding("owner", "other-parent", incarnation)
            .unwrap());
        assert!(!supervisor
            .parent_has_outstanding("other-owner", "parent", incarnation)
            .unwrap());
    }

    #[test]
    fn cancellation_at_commit_guard_rolls_back_admission() {
        let (_dir, outbox) = store();
        let b = binding();
        let calls = std::cell::Cell::new(0);
        let result = outbox.admit_checked(&b, || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(())
            } else {
                Err("cancelled".into())
            }
        });
        assert_eq!(result.unwrap_err(), "cancelled");
        assert!(outbox.read(&b.owner, b.operation_id).unwrap().is_none());
    }
    #[test]
    fn approved_request_is_bound_and_cannot_change_after_restart() {
        let (dir, store) = store();
        let mut b = binding();
        b.parent_turn = "turn-1".into();
        b.workspace = "/tmp/workspace".into();
        b.provider = "openai-api".into();
        b.model = "model-1".into();
        b.prompt = "Inspect the project".into();
        b.permission = Permission::ReadOnlyChild;
        store.admit(&b).unwrap();
        drop(store);
        let store = reopen(&dir.path().join("outbox"));
        assert_eq!(
            store
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            b
        );
        let mut changed = b.clone();
        changed.prompt.push('!');
        assert!(store.admit(&changed).is_err());
        changed = b.clone();
        changed.parent_turn.push('!');
        assert!(store.admit(&changed).is_err());
        changed = b.clone();
        changed.workspace.push('!');
        assert!(store.admit(&changed).is_err());
        changed = b.clone();
        changed.provider.push('!');
        assert!(store.admit(&changed).is_err());
        changed = b.clone();
        changed.model.push('!');
        assert!(store.admit(&changed).is_err());
    }
    #[test]
    fn admission_rejects_incomplete_or_oversized_approved_scope() {
        let (_dir, store) = store();
        let original = binding();
        let mut invalid = original.clone();
        invalid.parent_turn.clear();
        assert!(store.admit(&invalid).is_err());
        invalid = original.clone();
        invalid.workspace = "relative/path".into();
        assert!(store.admit(&invalid).is_err());
        invalid = original.clone();
        invalid.model.clear();
        assert!(store.admit(&invalid).is_err());
        invalid = original.clone();
        invalid.prompt = " ".into();
        assert!(store.admit(&invalid).is_err());
        invalid.prompt = "x".repeat(50_001);
        assert!(store.admit(&invalid).is_err());
        invalid.prompt = "four".repeat(MAX_PROMPT_BYTES / 4 + 1);
        assert!(store.admit(&invalid).is_err());
        assert!(store.list(&original.owner).unwrap().is_empty());
    }
    #[test]
    fn older_unbound_ledger_is_not_silently_upgraded() {
        for version in [1, 3, 4, 5] {
            let (dir, store) = store();
            store.admit(&binding()).unwrap();
            store
                .db
                .lock()
                .unwrap()
                .execute_batch(&format!("PRAGMA user_version={version};"))
                .unwrap();
            drop(store);
            assert!(Outbox::open(&dir.path().join("outbox")).is_err());
        }
    }
    #[test]
    fn unapplied_busy_delivery_claim_is_released_once_and_only_before_a_receipt() {
        let (_data, outbox) = store();
        let b = binding();
        outbox.admit(&b).unwrap();
        let result = "No answer was returned.".to_string();
        let t = Terminal {
            outcome: Outcome::Interrupted,
            result: result.clone(),
            source_digest: None,
            mutation: Mutation {
                operation_id: b.operation_id,
                expected_queue_revision: 0,
                operation: QueueOperation::Enqueue {
                    item_id: b.operation_id,
                    text: format!("Delegated task {} (interrupted):\n{result}", b.task),
                    run_when_idle: false,
                },
            },
        };
        outbox.finish("owner", b.operation_id, &t).unwrap();
        assert!(outbox
            .release_unapplied_delivery("owner", b.operation_id)
            .is_err());
        outbox
            .bind_first_delivery("owner", b.operation_id, 5)
            .unwrap();
        assert!(outbox
            .bind_first_delivery("owner", b.operation_id, 5)
            .is_err());
        outbox
            .release_unapplied_delivery("owner", b.operation_id)
            .unwrap();
        assert!(outbox
            .release_unapplied_delivery("owner", b.operation_id)
            .is_err());
        outbox
            .bind_first_delivery("owner", b.operation_id, 5)
            .unwrap();
        outbox
            .record_receipt("owner", b.operation_id, &receipt(&t), |_, _| Ok(true))
            .unwrap();
        assert!(outbox
            .release_unapplied_delivery("owner", b.operation_id)
            .is_err());
        assert!(is_unapplied_busy(
            "Unavailable(\"Queue storage is busy; retry\")"
        ));
        assert!(is_unapplied_busy(
            "Unavailable(\"Queue storage is busy or unavailable\")"
        ));
        assert!(!is_unapplied_busy(
            "Unavailable(\"Cannot write queue file\")"
        ));
        assert!(!is_unapplied_busy("Queue publication outcome is uncertain"));
    }

    #[test]
    fn terminal_is_durable_exact_and_receipt_requires_verification() {
        let (dir, store) = store();
        let b = binding();
        let t = terminal(&b);
        store.admit(&b).unwrap();
        assert!(store
            .record_receipt(&b.owner, b.operation_id, &receipt(&t), |_, _| Ok(false))
            .is_err());
        store.finish(&b.owner, b.operation_id, &t).unwrap();
        assert!(store.finish("foreign", b.operation_id, &t).is_err());
        let mut changed = t.clone();
        changed.result.push('!');
        assert!(store.finish(&b.owner, b.operation_id, &changed).is_err());
        changed = t.clone();
        changed.outcome = Outcome::Failed;
        assert!(store.finish(&b.owner, b.operation_id, &changed).is_err());
        changed = t.clone();
        changed.mutation.expected_queue_revision += 1;
        assert!(store.finish(&b.owner, b.operation_id, &changed).is_err());
        drop(store);
        let store = reopen(&dir.path().join("outbox"));
        assert_eq!(
            store
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .terminal,
            Some(t.clone())
        );
        assert!(store
            .record_receipt(&b.owner, b.operation_id, &receipt(&t), |_, _| Ok(false))
            .is_err());
        store
            .record_receipt(&b.owner, b.operation_id, &receipt(&t), |mutation, r| {
                Ok(mutation == &t.mutation && r == &receipt(&t))
            })
            .unwrap();
        assert_eq!(
            store
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .receipt,
            Some(receipt(&t))
        );
    }
    #[test]
    fn no_recreation_and_exclusive_ownership() {
        let (dir, store) = store();
        let path = dir.path().join("outbox");
        assert!(Outbox::open(&path).is_err());
        drop(store);
        std::fs::remove_file(path.join("outbox.sqlite3")).unwrap();
        assert!(Outbox::open(&path).is_err());
        assert!(!path.join("outbox.sqlite3").exists());
    }

    #[test]
    fn provisioning_reopens_only_the_original_ledger_and_never_recreates_missing_state() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let data = root.path().canonicalize().unwrap();
        let ledger = data.join("delegation-outbox");
        let store = Outbox::open_or_provision(&data).unwrap();
        assert!(Outbox::open_or_provision(&data).is_err());
        run_helper(&data, "guard-locked");
        drop(store);
        drop(Outbox::open_or_provision(&data).unwrap());
        run_helper(&data, "guard-open");

        let database = ledger.join("outbox.sqlite3");
        let bytes = std::fs::read(&database).unwrap();
        let original_database = File::open(&database).unwrap();
        std::fs::remove_file(&database).unwrap();
        assert!(Outbox::open_or_provision(&data).is_err());
        assert!(!database.exists());
        std::fs::write(&database, &bytes).unwrap();
        std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Outbox::open_or_provision(&data).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), bytes);
        drop(original_database);

        let other = tempfile::tempdir().unwrap();
        let other_data = other.path().canonicalize().unwrap();
        std::fs::create_dir(other_data.join("delegation-outbox")).unwrap();
        assert!(Outbox::open_or_provision(&other_data).is_err());
        assert!(!other_data.join("delegation-outbox.guard").exists());

        let incomplete = tempfile::tempdir().unwrap();
        let incomplete_data = incomplete.path().canonicalize().unwrap();
        let guard = incomplete_data.join("delegation-outbox.guard");
        std::fs::write(&guard, b"initializing\n").unwrap();
        std::fs::set_permissions(&guard, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Outbox::open_or_provision(&incomplete_data).is_err());
        assert_eq!(std::fs::read(&guard).unwrap(), b"initializing\n");
        assert!(!incomplete_data.join("delegation-outbox").exists());

        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        std::fs::create_dir(&original).unwrap();
        std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = original.canonicalize().unwrap();
        drop(Outbox::open_or_provision(&original).unwrap());
        let moved = original.with_file_name("moved");
        std::fs::rename(&original, &moved).unwrap();
        assert!(Outbox::open_or_provision(&moved).is_err());
        assert!(moved.join("delegation-outbox/outbox.sqlite3").exists());
    }
    #[test]
    fn enqueue_never_requests_automatic_resume_and_output_is_bounded() {
        let (_dir, store) = store();
        let b = binding();
        store.admit(&b).unwrap();
        let mut t = terminal(&b);
        if let QueueOperation::Enqueue { run_when_idle, .. } = &mut t.mutation.operation {
            *run_when_idle = true;
        }
        assert!(store.finish(&b.owner, b.operation_id, &t).is_err());
        t = terminal(&b);
        t.result = "x".repeat(MAX_RESULT_BYTES + 1);
        assert!(store.finish(&b.owner, b.operation_id, &t).is_err());
    }
    #[test]
    fn concurrent_admission_is_single_and_retained_after_reopen() {
        use std::sync::{Arc, Barrier};
        let (dir, store) = store();
        let store = Arc::new(store);
        let b = binding();
        let barrier = Arc::new(Barrier::new(8));
        let joins: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let b = b.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.admit(&b).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = joins.into_iter().map(|j| j.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| **r == Admission::New).count(), 1);
        drop(store);
        let reopened = reopen(&dir.path().join("outbox"));
        assert_eq!(reopened.admit(&b).unwrap(), Admission::Existing);
    }
    #[test]
    fn rejects_symlinks_corruption_and_missing_initialization() {
        use std::os::unix::fs::symlink;
        let (dir, store) = store();
        let path = dir.path().join("outbox");
        drop(store);
        let alias = dir.path().join("alias");
        symlink(&path, &alias).unwrap();
        assert!(Outbox::open(&alias).is_err());
        std::fs::rename(path.join("outbox.sqlite3"), path.join("saved")).unwrap();
        symlink(path.join("saved"), path.join("outbox.sqlite3")).unwrap();
        assert!(Outbox::open(&path).is_err());
        std::fs::remove_file(path.join("outbox.sqlite3")).unwrap();
        std::fs::write(path.join("outbox.sqlite3"), b"not a database").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path.join("outbox.sqlite3"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(Outbox::open(&path).is_err());
        assert!(Outbox::open(&dir.path().join("absent")).is_err());
        assert!(!dir.path().join("absent").exists());
    }
    #[test]
    fn real_queue_dedupe_reconciliation_preserves_holds() {
        use crate::followup_queue::{HoldReason, QueueMode, QueueScope, QueueStore};
        let (dir, store) = store();
        let queue = QueueStore::new(dir.path(), Uuid::new_v4());
        let parent = format!("ss-{}", Uuid::new_v4().simple());
        let scope = QueueScope::new("owner", dir.path(), &parent).unwrap();
        let pause = Mutation {
            operation_id: Uuid::new_v4(),
            expected_queue_revision: 0,
            operation: QueueOperation::Pause,
        };
        queue.mutate(&scope, pause).unwrap();
        let mut b = binding();
        b.parent_session = parent;
        let mut t = terminal(&b);
        t.mutation.expected_queue_revision = 1;
        store.admit(&b).unwrap();
        store.finish(&b.owner, b.operation_id, &t).unwrap();
        let received = queue.mutate(&scope, t.mutation.clone()).unwrap();
        drop(store);
        let store = reopen(&dir.path().join("outbox"));
        assert_eq!(
            queue.load(&scope).unwrap().hold_reason,
            Some(HoldReason::Manual)
        );
        let restarted = QueueStore::new(dir.path(), Uuid::new_v4());
        let held = restarted.load(&scope).unwrap();
        assert_eq!(
            (held.mode, held.hold_reason),
            (QueueMode::Held, Some(HoldReason::Restart))
        );
        store
            .record_receipt(&b.owner, b.operation_id, &received, |mutation, receipt| {
                Ok(restarted
                    .verify_operation_receipt(&scope, mutation)
                    .map_err(|e| format!("{e:?}"))?
                    .as_ref()
                    == Some(receipt))
            })
            .unwrap();
        assert_eq!(
            restarted.load(&scope).unwrap().hold_reason,
            Some(HoldReason::Restart)
        );
        let mut wrong = t.mutation.clone();
        if let QueueOperation::Enqueue { text, .. } = &mut wrong.operation {
            text.push('!');
        }
        assert!(restarted.mutate(&scope, wrong).is_err());
    }
    #[tokio::test]
    async fn parent_lifecycle_reconciles_only_an_existing_exact_queue_mutation() {
        use crate::followup_queue::{QueueScope, QueueStore};
        use crate::structured::StructuredSessionManager;
        use terminal_v4_core::AppConfig;

        let (data, outbox) = store();
        let workspace = tempfile::tempdir().unwrap();
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
        let manager = StructuredSessionManager::new(AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        });
        manager.bind_live_ownership().unwrap();
        let parent = manager
            .create_session(
                "owner",
                workspace.path().to_str().unwrap(),
                Some("deepseek"),
                None,
                None,
            )
            .await
            .unwrap();
        let mut b = binding();
        b.parent_session = parent.id;
        b.parent_incarnation = manager
            .session_incarnation_for_test("owner", &b.parent_session)
            .await;
        b.workspace = workspace
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        b.data_root = data
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let queue = QueueStore::new(
            data.path(),
            crate::structured::queue::manager_boot_id(&manager),
        );
        let scope = QueueScope::new(&b.owner, workspace.path(), &b.parent_session).unwrap();
        queue.load(&scope).unwrap();
        b.queue_identity = queue.ensure_existing_identity(&scope).unwrap().unwrap();
        let t = Terminal {
            outcome: Outcome::Cancelled,
            result: "No answer was returned.".into(),
            source_digest: None,
            mutation: Mutation {
                operation_id: b.operation_id,
                expected_queue_revision: 0,
                operation: QueueOperation::Enqueue {
                    item_id: b.operation_id,
                    text: format!(
                        "Delegated task {} (cancelled):\nNo answer was returned.",
                        b.task
                    ),
                    run_when_idle: false,
                },
            },
        };
        outbox.admit(&b).unwrap();
        outbox.finish(&b.owner, b.operation_id, &t).unwrap();

        assert_eq!(
            outbox
                .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
                .await
                .unwrap(),
            None
        );
        assert!(outbox
            .read(&b.owner, b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
        assert!(outbox
            .reconcile_existing_receipt(&manager, "foreign", b.operation_id)
            .await
            .is_err());

        let receipt = queue.mutate(&scope, t.mutation.clone()).unwrap();
        assert_eq!(
            outbox
                .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
                .await
                .unwrap(),
            Some(())
        );
        assert_eq!(
            outbox
                .read(&b.owner, b.operation_id)
                .unwrap()
                .unwrap()
                .receipt,
            Some(receipt)
        );
        assert_eq!(
            outbox
                .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
                .await
                .unwrap(),
            Some(())
        );
        manager
            .delete_session(&b.owner, &b.parent_session)
            .await
            .unwrap();
        assert!(outbox
            .reconcile_existing_receipt(&manager, &b.owner, b.operation_id)
            .await
            .is_err());
    }
    #[test]
    fn subprocess_helper() {
        let Ok(path) = std::env::var("OUTBOX_TEST_PATH") else {
            return;
        };
        match std::env::var("OUTBOX_TEST_MODE").unwrap().as_str() {
            "locked" => assert!(Outbox::open(Path::new(&path)).is_err()),
            "guard-locked" => assert!(Outbox::open_or_provision(Path::new(&path)).is_err()),
            "guard-open" => drop(Outbox::open_or_provision(Path::new(&path)).unwrap()),
            "crash" => {
                let store = Outbox::open(Path::new(&path)).unwrap();
                let db = store.db.lock().unwrap();
                db.execute_batch("BEGIN IMMEDIATE; DELETE FROM records;")
                    .unwrap();
                std::process::exit(0);
            }
            _ => panic!("Unknown helper mode"),
        }
    }
    fn run_helper(path: &Path, mode: &str) {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "v4_agent::delegation_outbox::tests::subprocess_helper",
                "--nocapture",
            ])
            .env("OUTBOX_TEST_PATH", path)
            .env("OUTBOX_TEST_MODE", mode)
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[test]
    fn process_lock_and_uncommitted_crash_recovery() {
        let (dir, store) = store();
        let b = binding();
        store.admit(&b).unwrap();
        let path = dir.path().join("outbox");
        run_helper(&path, "locked");
        drop(store);
        run_helper(&path, "crash");
        let reopened = reopen(&path);
        assert_eq!(reopened.admit(&b).unwrap(), Admission::Existing);
    }
    #[test]
    fn capacity_refuses_new_records_without_forgetting_existing_bindings() {
        let (_dir, store) = store();
        let existing = binding();
        store.admit(&existing).unwrap();
        {
            let mut db = store.db.lock().unwrap();
            let tx = db.transaction().unwrap();
            for i in 1..MAX_RECORDS {
                let mut b = binding();
                b.child_session = format!("child-{i}");
                b.task = format!("task-{i}");
                tx.execute("INSERT INTO records(owner,operation_id,child,task,binding) VALUES(?1,?2,?3,?4,?5)", params![b.owner, b.operation_id.to_string(), b.child_session, b.task, encode(&b).unwrap()]).unwrap();
            }
            tx.commit().unwrap();
        }
        let mut new = binding();
        new.child_session = "new".into();
        new.task = "new".into();
        assert!(store.admit(&new).is_err());
        assert_eq!(store.admit(&existing).unwrap(), Admission::Existing);
        assert_eq!(store.list("owner").unwrap().len(), MAX_RECORDS as usize);
    }
    #[test]
    fn queue_receipt_with_conflicting_payload_is_not_acknowledged() {
        use crate::followup_queue::{QueueScope, QueueStore};
        let (dir, store) = store();
        let queue = QueueStore::new(dir.path(), Uuid::new_v4());
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        let scope = QueueScope::new(&b.owner, dir.path(), &b.parent_session).unwrap();
        let mut intended = terminal(&b);
        intended.mutation.expected_queue_revision = 0;
        store.admit(&b).unwrap();
        store.finish(&b.owner, b.operation_id, &intended).unwrap();
        let mut different = intended.mutation.clone();
        if let QueueOperation::Enqueue { text, .. } = &mut different.operation {
            text.push('!');
        }
        let received = queue.mutate(&scope, different).unwrap();
        assert!(store
            .record_receipt(&b.owner, b.operation_id, &received, |mutation, receipt| {
                Ok(queue
                    .verify_operation_receipt(&scope, mutation)
                    .is_ok_and(|verified| verified.as_ref() == Some(receipt)))
            })
            .is_err());
        assert!(store
            .read(&b.owner, b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
    }

    #[test]
    fn missing_queue_receipt_cannot_create_or_acknowledge_delivery() {
        use crate::followup_queue::{QueueScope, QueueStore};
        let (dir, store) = store();
        let queue = QueueStore::new(dir.path(), Uuid::new_v4());
        let mut b = binding();
        b.parent_session = format!("ss-{}", Uuid::new_v4().simple());
        let scope = QueueScope::new(&b.owner, dir.path(), &b.parent_session).unwrap();
        let t = terminal(&b);
        store.admit(&b).unwrap();
        store.finish(&b.owner, b.operation_id, &t).unwrap();
        assert!(store
            .record_receipt(
                &b.owner,
                b.operation_id,
                &receipt(&t),
                |mutation, receipt| {
                    Ok(queue
                        .verify_operation_receipt(&scope, mutation)
                        .map_err(|e| format!("{e:?}"))?
                        .as_ref()
                        == Some(receipt))
                }
            )
            .is_err());
        assert!(!dir.path().join("followup-queues").exists());
        assert!(store
            .read(&b.owner, b.operation_id)
            .unwrap()
            .unwrap()
            .receipt
            .is_none());
    }
}
