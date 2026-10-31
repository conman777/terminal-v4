//! Owner-bound delegation cleanup and user-reviewed recovery receipts.
use super::*;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{FileExt, MetadataExt};

fn child_failed(child: &SupervisedChild) -> bool {
    child
        .completion
        .borrow()
        .as_ref()
        .is_some_and(Result::is_err)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CleanupReceipt {
    owner: String,
    request: Uuid,
    supervisor_instance: Uuid,
    outbox_identity: String,
}

impl CleanupReceipt {
    pub(crate) fn owner(&self) -> &str {
        &self.owner
    }
    pub(crate) fn request(&self) -> Uuid {
        self.request
    }
    pub(crate) fn supervisor_instance(&self) -> Uuid {
        self.supervisor_instance
    }
    pub(crate) fn outbox_identity(&self) -> &str {
        &self.outbox_identity
    }
}

impl DelegationSupervisor {
    pub(crate) async fn pending_owner_reviews(
        &self,
        owner: &str,
        request: Uuid,
        verify_hold: impl FnOnce(&str, Uuid) -> Result<()>,
    ) -> Result<Vec<serde_json::Value>> {
        if !valid_identity(owner) || request.is_nil() {
            return Err("Invalid owner cleanup request".into());
        }
        let _cleanup = self.lock_owner_cleanup(owner).await?;
        verify_hold(owner, request)?;
        let pending = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if state.closing || state.recovering_owners.contains(owner) {
                return Err("Delegation recovery is unavailable".into());
            }
            let mut pending = state
                .startup_pending
                .iter()
                .filter(|(id, operation)| {
                    id == owner && state.children.get(operation).is_none_or(child_failed)
                })
                .map(|(_, operation)| *operation)
                .collect::<std::collections::HashSet<_>>();
            pending.extend(
                state
                    .children
                    .iter()
                    .filter(|(_, child)| child.owner == owner && child_failed(child))
                    .map(|(operation, _)| *operation),
            );
            pending
        };
        let records = self.outbox.list(owner)?;
        Ok(records.into_iter().filter(|record| record.terminal.is_none() && pending.contains(&record.binding.operation_id)).map(|record| {
            let binding = record.binding;
            serde_json::json!({"childOperationId":binding.operation_id,"taskId":binding.task,"childSessionId":binding.child_session,"workspacePath":binding.workspace,"provider":binding.provider,"model":binding.model})
        }).collect())
    }

    /// Finished results the owner has not received in a parent queue, including
    /// those of a deleted parent. Unlike `pending_owner_reviews`, these need no
    /// recovery decision; they are surfaced so the result is not silently lost.
    pub(crate) async fn retained_owner_results(
        &self,
        owner: &str,
        request: Uuid,
        verify_hold: impl FnOnce(&str, Uuid) -> Result<()>,
    ) -> Result<Vec<serde_json::Value>> {
        const PREVIEW_CHARS: usize = 4000;
        if !valid_identity(owner) || request.is_nil() {
            return Err("Invalid owner cleanup request".into());
        }
        let _cleanup = self.lock_owner_cleanup(owner).await?;
        verify_hold(owner, request)?;
        let records = self.outbox.list(owner)?;
        Ok(records
            .into_iter()
            .filter(|record| record.receipt.is_none())
            .filter_map(|record| {
                let terminal = record.terminal?;
                let binding = record.binding;
                let truncated = terminal.result.chars().count() > PREVIEW_CHARS;
                Some(serde_json::json!({
                    "childOperationId": binding.operation_id,
                    "taskId": binding.task,
                    "childSessionId": binding.child_session,
                    "parentSessionId": binding.parent_session,
                    "workspacePath": binding.workspace,
                    "provider": binding.provider,
                    "model": binding.model,
                    "outcome": terminal.outcome,
                    "result": terminal.result.chars().take(PREVIEW_CHARS).collect::<String>(),
                    "resultTruncated": truncated,
                }))
            })
            .collect())
    }

    pub(crate) async fn review_held_child(
        self: &Arc<Self>,
        app: crate::state::AppState,
        owner: String,
        authority: crate::auth::LocalAuthority,
        request: Uuid,
        operation: Uuid,
        child_operation: Uuid,
        acknowledged: bool,
    ) -> Result<()> {
        if !acknowledged
            || !valid_identity(&owner)
            || request.is_nil()
            || operation.is_nil()
            || child_operation.is_nil()
        {
            return Err("Explicit acknowledgment and valid review identity are required".into());
        }
        let _cleanup = self.lock_owner_cleanup(&owner).await?;
        let record = self
            .outbox
            .read(&owner, child_operation)?
            .ok_or("Delegated child is unavailable")?;
        let binding = record.binding;
        let task = Uuid::parse_str(&binding.task).map_err(|_| "Invalid delegated task")?;
        let child =
            Uuid::parse_str(&binding.child_session).map_err(|_| "Invalid delegated session")?;
        let outbox = self.cleanup_outbox_identity()?;
        let supervisor = Arc::clone(self);
        let review_owner = owner.clone();
        tokio::task::spawn_blocking(move || {
            let owner = review_owner;
            app.with_owner_review(&owner, &authority, |tx, check| {
                check()?;
                let held: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1 AND request=?2)", rusqlite::params![owner,request.to_string()], |row| row.get(0)).map_err(|_| "Cannot inspect owner cleanup hold")?;
                if !held { return Err("Owner cleanup request changed".into()); }
                let prior: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_delegation_reviews WHERE owner=?1 AND request=?2 AND operation=?3 AND child_operation=?4 AND task=?5 AND child_session=?6 AND outbox_identity=?7)", rusqlite::params![owner,request.to_string(),operation.to_string(),child_operation.to_string(),task.to_string(),child.to_string(),outbox], |row| row.get(0)).map_err(|_| "Cannot inspect delegation review")?;
                if !prior {
                    if record.terminal.is_some() || supervisor.cleanup_outbox_identity()? != outbox { return Err("Delegated child changed".into()); }
                    let mut state = supervisor.state.lock().map_err(|_| "Delegation supervisor unavailable")?;
                    let tracked = state.children.get(&child_operation);
                    let failed = tracked.is_some_and(child_failed);
                    if state.closing || state.recovering_owners.contains(&owner) || tracked.is_some_and(|child| !child_failed(child)) || (!failed && !state.startup_pending.contains(&(owner.clone(), child_operation))) { return Err("Delegated child is not eligible for review".into()); }
                    state.fenced_owners.insert(owner.clone());
                    state.cleanup_requests.insert(owner.clone(), request);
                    drop(state);
                }
                crate::structured::owner_cleanup::OwnerCleanup::record_delegation_review(tx, &owner, request, operation, child_operation, task, child, &outbox)?;
                check()?;
                Ok(())
            })
        }).await.map_err(|_| "Delegation review outcome is uncertain")??;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Delegation review outcome is uncertain")?;
        if state.closing {
            return Err("Delegation review outcome is uncertain".into());
        }
        if state
            .children
            .get(&child_operation)
            .is_some_and(child_failed)
        {
            state.children.remove(&child_operation);
            state.startup_pending.insert((owner, child_operation));
        }
        Ok(())
    }

    pub(crate) async fn recover_held_owner<F>(
        self: &Arc<Self>,
        owner: &str,
        request: Uuid,
        verify_hold: F,
    ) -> Result<usize>
    where
        F: Fn(&str, Uuid) -> Result<()> + Send + Sync + 'static,
    {
        self.recover_held_owner_with_review(owner, request, verify_hold, |_, _, _, _, _, _| {
            Ok(false)
        })
        .await
    }

    pub(crate) async fn recover_held_owner_with_review<F, R>(
        self: &Arc<Self>,
        owner: &str,
        request: Uuid,
        verify_hold: F,
        reviewed: R,
    ) -> Result<usize>
    where
        F: Fn(&str, Uuid) -> Result<()> + Send + Sync + 'static,
        R: Fn(&str, Uuid, Uuid, Uuid, Uuid, &str) -> Result<bool> + Send + Sync + 'static,
    {
        if !valid_identity(owner) || request.is_nil() {
            return Err("Invalid owner cleanup request".into());
        }
        let _cleanup = self.lock_owner_cleanup(owner).await?;
        let verify_hold = Arc::new(verify_hold);
        let reviewed = Arc::new(reviewed);
        verify_hold(owner, request)?;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if state.closing {
                return Err("Delegation supervisor is shutting down".into());
            }
            state.fenced_owners.insert(owner.into());
            state.cleanup_requests.insert(owner.into(), request);
            if state.recovering_owners.contains(owner) {
                return Err("Delegation recovery is still running".into());
            }
        }
        let mut recovered = 0;
        for record in self.outbox.list(owner)? {
            let binding = record.binding;
            let pending = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?
                .startup_pending
                .contains(&(owner.into(), binding.operation_id));
            if !pending {
                continue;
            }
            verify_hold(owner, request)?;
            if record.terminal.is_none() {
                let supervisor = Arc::clone(self);
                let verified = Arc::clone(&verify_hold);
                let reviewed = Arc::clone(&reviewed);
                let binding_copy = binding.clone();
                let outbox_identity = self.cleanup_outbox_identity()?;
                let saved = tokio::task::spawn_blocking(move || {
                    let task =
                        Uuid::parse_str(&binding_copy.task).map_err(|_| "Invalid task ID")?;
                    let child = Uuid::parse_str(&binding_copy.child_session)
                        .map_err(|_| "Invalid child session")?;
                    let was_reviewed = reviewed(
                        &binding_copy.owner,
                        request,
                        binding_copy.operation_id,
                        task,
                        child,
                        &outbox_identity,
                    )?;
                    let authorize = || {
                        verified(&binding_copy.owner, request)
                            .map_err(crate::ApiError::internal)?;
                        if was_reviewed
                            && (!reviewed(
                                &binding_copy.owner,
                                request,
                                binding_copy.operation_id,
                                task,
                                child,
                                &outbox_identity,
                            )
                            .map_err(crate::ApiError::internal)?
                                || supervisor
                                    .cleanup_outbox_identity()
                                    .map_err(crate::ApiError::internal)?
                                    != outbox_identity)
                        {
                            return Err(crate::ApiError::internal("Delegation review changed"));
                        }
                        let state = supervisor.state.lock().map_err(|_| {
                            crate::ApiError::internal("Delegation supervisor unavailable")
                        })?;
                        if state.closing
                            || state.cleanup_requests.get(&binding_copy.owner) != Some(&request)
                            || !state.fenced_owners.contains(&binding_copy.owner)
                            || !state
                                .startup_pending
                                .contains(&(binding_copy.owner.clone(), binding_copy.operation_id))
                        {
                            return Err(crate::ApiError::internal(
                                "Delegation cleanup scope changed",
                            ));
                        }
                        Ok(state)
                    };
                    if was_reviewed {
                        crate::workspace_tasks::recover_unfinished_delegation(
                            &supervisor.outbox.data_root,
                            &binding_copy.owner,
                            task,
                            child,
                            &binding_copy.task_input(),
                            authorize,
                        )
                    } else {
                        crate::workspace_tasks::recover_held_unlaunched_delegation(
                            &supervisor.outbox.data_root,
                            &binding_copy.owner,
                            task,
                            child,
                            &binding_copy.task_input(),
                            authorize,
                        )
                    }
                    .map_err(|error| error.message)
                })
                .await
                .map_err(|_| "Delegated task recovery is unconfirmed")??;
                if saved.is_none() {
                    return Err("Delegated task is unavailable; cleanup is unconfirmed".into());
                }
                self.outbox
                    .stage_persisted_task_result(owner, binding.operation_id, 0)
                    .await?
                    .ok_or("Delegated task outcome is unavailable")?;
            }
            verify_hold(owner, request)?;
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if state.cleanup_requests.get(owner) != Some(&request) {
                return Err("Delegation cleanup scope changed".into());
            }
            state
                .startup_pending
                .remove(&(owner.into(), binding.operation_id));
            recovered += 1;
        }
        Ok(recovered)
    }

    fn cleanup_outbox_identity(&self) -> Result<String> {
        let guard = self
            .outbox
            ._provision_guard
            .as_ref()
            .ok_or("Delegation outbox ownership is unconfirmed")?;
        let guard_path = self.outbox.data_root.join("delegation-outbox.guard");
        check_file(&guard_path)?;
        let opened = guard
            .metadata()
            .map_err(|_| "Delegation outbox guard unavailable")?;
        let current = std::fs::symlink_metadata(&guard_path)
            .map_err(|_| "Delegation outbox guard unavailable")?;
        if (opened.dev(), opened.ino()) != (current.dev(), current.ino()) || opened.len() > 4096 {
            return Err("Delegation outbox guard changed".into());
        }
        let mut bytes = vec![0; opened.len() as usize];
        guard
            .read_exact_at(&mut bytes, 0)
            .map_err(|_| "Delegation outbox guard unavailable")?;
        let expected: OutboxIdentity =
            serde_json::from_slice(&bytes).map_err(|_| "Delegation outbox guard invalid")?;
        let current = outbox_identity(&self.outbox.data_root.join("delegation-outbox"))?;
        let owned = self
            .outbox
            ._lock
            .metadata()
            .map_err(|_| "Delegation outbox ownership unavailable")?;
        if expected != current || (owned.dev(), owned.ino()) != expected.lock {
            return Err("Delegation outbox ownership changed".into());
        }
        Ok(format!("{:x}", Sha256::digest(&bytes)))
    }

    pub(crate) async fn acknowledge_owner_cleanup(
        &self,
        owner: &str,
        request: Uuid,
        commit: impl FnOnce(&CleanupReceipt) -> Result<()>,
    ) -> Result<CleanupReceipt> {
        if !valid_identity(owner) || request.is_nil() {
            return Err("Invalid owner cleanup request".into());
        }
        let _cleanup = self.lock_owner_cleanup(owner).await?;
        let children = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if state.closing {
                return Err("Delegation supervisor is shutting down".into());
            }
            state.fenced_owners.insert(owner.into());
            state.cleanup_requests.insert(owner.into(), request);
            if state.recovering_owners.contains(owner) {
                return Err("Delegation recovery is still running".into());
            }
            if state
                .startup_pending
                .iter()
                .any(|(pending_owner, _)| pending_owner == owner)
            {
                return Err("Delegated child cleanup is unconfirmed after restart".into());
            }
            state
                .children
                .values()
                .filter(|child| child.owner == owner)
                .map(|child| (child.shutdown.clone(), child.completion.clone()))
                .collect()
        };
        Self::wait_children(children).await?;
        if self
            .outbox
            .list(owner)?
            .iter()
            .any(|record| record.terminal.is_none())
        {
            return Err("Delegated child outcome is unresolved".into());
        }
        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if state.closing
                || state.cleanup_requests.get(owner) != Some(&request)
                || state.recovering_owners.contains(owner)
                || state
                    .startup_pending
                    .iter()
                    .any(|(pending_owner, _)| pending_owner == owner)
            {
                return Err("Delegation cleanup scope changed".into());
            }
        }
        let receipt = CleanupReceipt {
            owner: owner.into(),
            request,
            supervisor_instance: self.cleanup_instance,
            outbox_identity: self.cleanup_outbox_identity()?,
        };
        // The coordinator must verify the current hold and commit this receipt in
        // one durable transaction; a failed or uncertain commit leaves the fence.
        commit(&receipt)?;
        Ok(receipt)
    }

    pub(crate) async fn release_owner_cleanup(
        &self,
        receipt: &CleanupReceipt,
        release: impl FnOnce(&CleanupReceipt) -> Result<()>,
    ) -> Result<()> {
        let _cleanup = self.lock_owner_cleanup(&receipt.owner).await?;
        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Delegation supervisor unavailable")?;
            if receipt.supervisor_instance != self.cleanup_instance
                || state.cleanup_requests.get(&receipt.owner) != Some(&receipt.request)
            {
                return Err("Delegation cleanup receipt is stale".into());
            }
        }
        if self.cleanup_outbox_identity()? != receipt.outbox_identity {
            return Err("Delegation outbox ownership changed".into());
        }
        // The callback must commit removal of the exact hold only after validating
        // every resource receipt; new starts must use that same admission gate.
        release(receipt)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Delegation supervisor unavailable")?;
        if state.cleanup_requests.get(&receipt.owner) != Some(&receipt.request) {
            return Err("Delegation cleanup scope changed".into());
        }
        state.cleanup_requests.remove(&receipt.owner);
        if !state.closing {
            state.fenced_owners.remove(&receipt.owner);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    async fn held_recovery_fixture() -> (tempfile::TempDir, tempfile::TempDir, Arc<Outbox>, Binding)
    {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let binding = Binding {
            owner: "owner".into(),
            data_root: root.path().to_string_lossy().into_owned(),
            parent_session: format!("ss-{}", Uuid::new_v4().simple()),
            parent_turn: "turn".into(),
            parent_incarnation: None,
            queue_identity: Uuid::new_v4(),
            child_session: Uuid::new_v4().to_string(),
            task: Uuid::new_v4().to_string(),
            workspace: workspace.path().to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: "deepseek-chat".into(),
            prompt: "Inspect".into(),
            permission: Permission::ReadOnlyChild,
            operation_id: Uuid::new_v4(),
            authorization: None,
            paired_authorization: None,
            paired_attestation: None,
        };
        let (task, _) = outbox
            .prepare_held_child(root.path(), &binding)
            .await
            .unwrap();
        assert_eq!(
            task.status,
            crate::workspace_tasks::TaskStatus::DelegationHeld
        );
        (root, workspace, outbox, binding)
    }

    #[tokio::test]
    async fn held_owner_recovery_stages_only_proven_unlaunched_child_without_parent() {
        let (root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let request = Uuid::new_v4();
        assert!(supervisor
            .recover_held_owner("owner", request, |_, _| Err("hold unavailable".into()))
            .await
            .is_err());
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_none());
        assert_eq!(
            supervisor
                .recover_held_owner("owner", request, move |owner, actual| {
                    if owner == "owner" && actual == request {
                        Ok(())
                    } else {
                        Err("hold changed".into())
                    }
                })
                .await
                .unwrap(),
            1
        );
        let saved = outbox.read("owner", binding.operation_id).unwrap().unwrap();
        assert_eq!(saved.terminal.unwrap().outcome, Outcome::Interrupted);
        assert!(!root.path().join("structured-sessions").exists());
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn held_owner_recovery_never_marks_a_possibly_running_child_stopped() {
        let (root, _workspace, outbox, binding) = held_recovery_fixture().await;
        crate::workspace_tasks::launch_held_delegation(
            root.path().to_path_buf(),
            "owner".into(),
            Uuid::parse_str(&binding.task).unwrap(),
            Uuid::parse_str(&binding.child_session).unwrap(),
            binding.task_input(),
            || Ok(()),
        )
        .await
        .unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        assert!(supervisor
            .recover_held_owner("owner", Uuid::new_v4(), |_, _| Ok(()))
            .await
            .is_err());
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_none());
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                root.path().to_path_buf(),
                "owner".into(),
                Uuid::parse_str(&binding.task).unwrap(),
                Uuid::parse_str(&binding.child_session).unwrap(),
                binding.task_input(),
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Running
        );
    }

    #[tokio::test]
    async fn finished_undelivered_result_is_surfaced_for_cleanup_review_until_delivered() {
        let (_root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let request = Uuid::new_v4();
        assert!(supervisor
            .retained_owner_results("owner", request, |_, _| Ok(()))
            .await
            .unwrap()
            .is_empty());
        supervisor
            .recover_held_owner("owner", request, |_, _| Ok(()))
            .await
            .unwrap();
        let pending = supervisor
            .pending_owner_reviews("owner", request, |_, _| Ok(()))
            .await
            .unwrap();
        assert!(pending.is_empty());

        let results = supervisor
            .retained_owner_results("owner", request, |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(
            results,
            vec![serde_json::json!({
                "childOperationId": binding.operation_id,
                "taskId": binding.task,
                "childSessionId": binding.child_session,
                "parentSessionId": binding.parent_session,
                "workspacePath": binding.workspace,
                "provider": "deepseek",
                "model": "deepseek-chat",
                "outcome": "interrupted",
                "result": outbox
                    .read("owner", binding.operation_id)
                    .unwrap()
                    .unwrap()
                    .terminal
                    .unwrap()
                    .result,
                "resultTruncated": false,
            })]
        );
        assert!(supervisor
            .retained_owner_results("foreign", request, |_, _| Ok(()))
            .await
            .unwrap()
            .is_empty());
        assert!(supervisor
            .retained_owner_results("owner", request, |_, _| Err("hold changed".into()))
            .await
            .is_err());

        let terminal = outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .unwrap();
        let crate::followup_queue::QueueOperation::Enqueue { item_id, .. } =
            terminal.mutation.operation
        else {
            unreachable!()
        };
        let receipt = crate::followup_queue::MutationReceipt {
            operation_id: binding.operation_id,
            queue_revision: terminal.mutation.expected_queue_revision + 1,
            item_id: Some(item_id),
            item_revision: Some(1),
        };
        outbox
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE records SET receipt=?2 WHERE operation_id=?1",
                params![binding.operation_id.to_string(), encode(&receipt).unwrap()],
            )
            .unwrap();
        assert!(supervisor
            .retained_owner_results("owner", request, |_, _| Ok(()))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn finished_failed_child_can_be_listed_for_explicit_review() {
        let (_root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let supervisor = Arc::new(DelegationSupervisor::new(outbox).unwrap());
        let (_sender, completion) =
            tokio::sync::watch::channel(Some(Err("cleanup unconfirmed".into())));
        {
            let mut state = supervisor.state.lock().unwrap();
            state
                .startup_pending
                .remove(&(binding.owner.clone(), binding.operation_id));
            state.children.insert(
                binding.operation_id,
                SupervisedChild {
                    owner: binding.owner.clone(),
                    parent: binding.parent_session.clone(),
                    shutdown: crate::v4_agent::interaction::Cancellation::default(),
                    completion,
                },
            );
        }
        let children = supervisor
            .pending_owner_reviews("owner", Uuid::new_v4(), |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(
            children[0]["childOperationId"],
            binding.operation_id.to_string()
        );
    }

    #[tokio::test]
    async fn reviewed_running_child_is_interrupted_without_replay() {
        let (root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let task = Uuid::parse_str(&binding.task).unwrap();
        let child = Uuid::parse_str(&binding.child_session).unwrap();
        crate::workspace_tasks::launch_held_delegation(
            root.path().to_path_buf(),
            "owner".into(),
            task,
            child,
            binding.task_input(),
            || Ok(()),
        )
        .await
        .unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let request = Uuid::new_v4();
        let child_operation = binding.operation_id;
        let wrong = Uuid::new_v4();
        assert!(supervisor
            .recover_held_owner_with_review(
                "owner",
                request,
                |_, _| Ok(()),
                move |_, _, operation, _, _, _| Ok(operation == wrong)
            )
            .await
            .is_err());
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                root.path().to_path_buf(),
                "owner".into(),
                task,
                child,
                binding.task_input()
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Running
        );
        assert_eq!(
            supervisor
                .recover_held_owner_with_review(
                    "owner",
                    request,
                    |_, _| Ok(()),
                    move |owner, actual, operation, actual_task, actual_child, _| Ok(owner
                        == "owner"
                        && actual == request
                        && operation == child_operation
                        && actual_task == task
                        && actual_child == child)
                )
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                root.path().to_path_buf(),
                "owner".into(),
                task,
                child,
                binding.task_input()
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Interrupted
        );
        assert_eq!(
            outbox
                .read("owner", child_operation)
                .unwrap()
                .unwrap()
                .terminal
                .unwrap()
                .outcome,
            Outcome::Interrupted
        );
        assert!(!root.path().join("structured-sessions").exists());
    }

    #[tokio::test]
    async fn authenticated_child_review_survives_restart_and_preserves_interrupted_result() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: root.path().into(),
            jwt_secret: "delegation-review-fixture".into(),
            ..Default::default()
        };
        let app = crate::state::AppState::new(config.clone()).unwrap();
        let manager = app.structured_session_manager();
        manager.bind_live_ownership().unwrap();
        manager
            .bind_owner_cleanup(app.provision_owner_cleanup().unwrap())
            .unwrap();
        app.create_local_user_for_test("alice", "fixture-password")
            .unwrap();
        app.create_local_user_for_test("bob", "fixture-password")
            .unwrap();
        let alice = app
            .login("alice", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let bob = app.login("bob", "fixture-password").await.unwrap().unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let binding = Binding {
            owner: alice.user.id.clone(),
            data_root: root.path().to_string_lossy().into_owned(),
            parent_session: format!("ss-{}", Uuid::new_v4().simple()),
            parent_turn: "turn".into(),
            parent_incarnation: None,
            queue_identity: Uuid::new_v4(),
            child_session: Uuid::new_v4().to_string(),
            task: Uuid::new_v4().to_string(),
            workspace: workspace.path().to_string_lossy().into_owned(),
            provider: "deepseek".into(),
            model: "deepseek-chat".into(),
            prompt: "Inspect".into(),
            permission: Permission::ReadOnlyChild,
            operation_id: Uuid::new_v4(),
            authorization: None,
            paired_authorization: None,
            paired_attestation: None,
        };
        outbox
            .prepare_held_child(root.path(), &binding)
            .await
            .unwrap();
        let task = Uuid::parse_str(&binding.task).unwrap();
        let child = Uuid::parse_str(&binding.child_session).unwrap();
        crate::workspace_tasks::launch_held_delegation(
            root.path().into(),
            binding.owner.clone(),
            task,
            child,
            binding.task_input(),
            || Ok(()),
        )
        .await
        .unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(outbox.clone()).unwrap());
        let (_failure_sender, failure) =
            tokio::sync::watch::channel(Some(Err("cleanup unconfirmed".into())));
        {
            let mut state = supervisor.state.lock().unwrap();
            state
                .startup_pending
                .remove(&(binding.owner.clone(), binding.operation_id));
            state.children.insert(
                binding.operation_id,
                SupervisedChild {
                    owner: binding.owner.clone(),
                    parent: binding.parent_session.clone(),
                    shutdown: crate::v4_agent::interaction::Cancellation::default(),
                    completion: failure,
                },
            );
        }
        manager
            .bind_delegation_supervisor(supervisor.clone())
            .unwrap();
        app.logout_user(&binding.owner).unwrap();
        let request_id: String = app
            .lock_db()
            .unwrap()
            .query_row(
                "SELECT request FROM structured_owner_holds WHERE owner=?1",
                [&binding.owner],
                |row| row.get(0),
            )
            .unwrap();
        let renewed = app
            .login("alice", "fixture-password")
            .await
            .unwrap()
            .unwrap();
        let router = crate::app(app.clone());
        let get = |token: &str, path: &str| {
            Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        let list = router
            .clone()
            .oneshot(get(
                &renewed.tokens.access_token,
                "/api/structured/owner-cleanup/delegation-children",
            ))
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let listed: serde_json::Value =
            serde_json::from_slice(&list.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(listed["requestId"], request_id);
        assert_eq!(
            listed["children"][0]["childOperationId"],
            binding.operation_id.to_string()
        );
        let operation = Uuid::new_v4();
        let post = |token: &str, ack| {
            Request::builder().method("POST").uri("/api/structured/owner-cleanup/delegation-review").header("authorization", format!("Bearer {token}")).header("content-type", "application/json").body(Body::from(serde_json::json!({"requestId":request_id,"operationId":operation,"childOperationId":binding.operation_id,"acknowledged":ack}).to_string())).unwrap()
        };
        assert_ne!(
            router
                .clone()
                .oneshot(post(&alice.tokens.access_token, true))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_ne!(
            router
                .clone()
                .oneshot(post(&bob.tokens.access_token, true))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            router
                .clone()
                .oneshot(post(&renewed.tokens.access_token, false))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let reviewed = router
            .clone()
            .oneshot(post(&renewed.tokens.access_token, true))
            .await
            .unwrap();
        assert_eq!(reviewed.status(), StatusCode::OK);
        let receipt: serde_json::Value =
            serde_json::from_slice(&reviewed.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(receipt["status"], "reviewed");
        assert_eq!(
            receipt["childOperationId"],
            binding.operation_id.to_string()
        );
        assert_eq!(
            router
                .clone()
                .oneshot(post(&renewed.tokens.access_token, true))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        drop(router);
        manager.shutdown().await.unwrap();
        drop(manager);
        drop(supervisor);
        drop(outbox);
        drop(app);
        let reopened = crate::state::AppState::new_runtime(config).unwrap();
        let manager = reopened.structured_session_manager();
        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                let held: bool = reopened
                    .lock_db()
                    .unwrap()
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                        [&binding.owner],
                        |row| row.get(0),
                    )
                    .unwrap();
                if !held {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("reviewed delegated child did not reconcile");
        assert_eq!(
            crate::workspace_tasks::delegated_task_status(
                root.path().into(),
                binding.owner.clone(),
                task,
                child,
                binding.task_input()
            )
            .await
            .unwrap(),
            crate::workspace_tasks::TaskStatus::Interrupted
        );
        let router = crate::app(reopened.clone());
        let path = format!("/api/structured/owner-cleanup/delegation-review/{operation}");
        let response = router
            .clone()
            .oneshot(get(&renewed.tokens.access_token, &path))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .oneshot(get(&bob.tokens.access_token, &path))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!root.path().join("structured-sessions").exists());
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn held_owner_recovery_never_recreates_a_missing_task_store() {
        let (root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let path = root.path().join("workspace-tasks").join(format!(
            "{:x}.json",
            Sha256::digest(binding.owner.as_bytes())
        ));
        std::fs::remove_file(&path).unwrap();
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let request = Uuid::new_v4();
        assert!(supervisor
            .recover_held_owner("owner", request, |_, _| Ok(()))
            .await
            .is_err());
        assert!(!path.exists());
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_none());
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn held_owner_recovery_rechecks_request_and_retries_a_staged_outcome() {
        let (_root, _workspace, outbox, binding) = held_recovery_fixture().await;
        let supervisor = Arc::new(DelegationSupervisor::new(Arc::clone(&outbox)).unwrap());
        let request = Uuid::new_v4();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let checks = calls.clone();
        assert!(supervisor
            .recover_held_owner("owner", request, move |_, _| {
                if checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3 {
                    Ok(())
                } else {
                    Err("hold changed".into())
                }
            })
            .await
            .is_err());
        assert!(outbox
            .read("owner", binding.operation_id)
            .unwrap()
            .unwrap()
            .terminal
            .is_some());
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .is_err());
        assert_eq!(
            supervisor
                .recover_held_owner("owner", request, |_, _| Ok(()))
                .await
                .unwrap(),
            1
        );
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn cleanup_receipt_is_durable_and_keeps_the_owner_fenced_until_exact_release() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = DelegationSupervisor::new(outbox).unwrap();
        let db_path = root.path().join("coordinator.db");
        let mut db = Connection::open(&db_path).unwrap();
        db.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE holds(owner TEXT PRIMARY KEY, request TEXT NOT NULL); CREATE TABLE receipts(owner TEXT PRIMARY KEY, request TEXT NOT NULL, supervisor TEXT NOT NULL, outbox TEXT NOT NULL);").unwrap();
        let request = Uuid::new_v4();
        db.execute(
            "INSERT INTO holds VALUES(?1,?2)",
            params!["owner", request.to_string()],
        )
        .unwrap();
        let receipt = supervisor
            .acknowledge_owner_cleanup("owner", request, |receipt| {
                let tx = db.transaction().map_err(|e| e.to_string())?;
                let matches: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM holds WHERE owner=?1 AND request=?2)",
                        params![receipt.owner, receipt.request.to_string()],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !matches {
                    return Err("Hold changed".into());
                }
                tx.execute(
                    "INSERT INTO receipts VALUES(?1,?2,?3,?4)",
                    params![
                        receipt.owner,
                        receipt.request.to_string(),
                        receipt.supervisor_instance.to_string(),
                        receipt.outbox_identity
                    ],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())
            })
            .await
            .unwrap();
        assert!(supervisor.resume_owner("owner").is_err());
        let reopened = Connection::open(&db_path).unwrap();
        let saved: (String, String, String, String) = reopened
            .query_row(
                "SELECT owner,request,supervisor,outbox FROM receipts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            saved,
            (
                receipt.owner().into(),
                receipt.request().to_string(),
                receipt.supervisor_instance().to_string(),
                receipt.outbox_identity().into()
            )
        );
        let renewed = Uuid::new_v4();
        db.execute(
            "UPDATE holds SET request=?1 WHERE owner='owner'",
            [renewed.to_string()],
        )
        .unwrap();
        assert!(supervisor
            .release_owner_cleanup(&receipt, |receipt| {
                let tx = db.transaction().map_err(|e| e.to_string())?;
                let removed = tx
                    .execute(
                        "DELETE FROM holds WHERE owner=?1 AND request=?2",
                        params![receipt.owner, receipt.request.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                if removed != 1 {
                    return Err("Hold changed".into());
                }
                tx.commit().map_err(|e| e.to_string())
            })
            .await
            .is_err());
        assert!(supervisor.resume_owner("owner").is_err());
    }

    #[tokio::test]
    async fn owner_cleanup_waits_for_existing_delegation_recovery() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = Arc::new(DelegationSupervisor::new(outbox).unwrap());
        let recovery = supervisor.begin_owner_recovery("owner").unwrap();
        let request = Uuid::new_v4();
        let committed = std::sync::atomic::AtomicBool::new(false);
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| {
                committed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!committed.load(std::sync::atomic::Ordering::SeqCst));
        drop(recovery);
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn unresolved_startup_child_prevents_acknowledgement_and_keeps_owner_fenced() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = DelegationSupervisor::new(outbox).unwrap();
        supervisor
            .state
            .lock()
            .unwrap()
            .startup_pending
            .insert(("owner".into(), Uuid::new_v4()));
        let called = std::sync::atomic::AtomicBool::new(false);
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", Uuid::new_v4(), |_| {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(supervisor.resume_owner("owner").is_err());
    }

    #[tokio::test]
    async fn failed_receipt_commit_keeps_fence_and_exact_release_clears_it() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = DelegationSupervisor::new(Arc::clone(&outbox)).unwrap();
        let request = Uuid::new_v4();
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Err("Commit uncertain".into()))
            .await
            .is_err());
        assert!(supervisor.resume_owner("owner").is_err());
        let receipt = supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .unwrap();
        let other_instance = DelegationSupervisor::new(outbox).unwrap();
        let invoked = std::sync::atomic::AtomicBool::new(false);
        assert!(other_instance
            .release_owner_cleanup(&receipt, |_| {
                invoked.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!invoked.load(std::sync::atomic::Ordering::SeqCst));
        assert!(supervisor
            .release_owner_cleanup(&receipt, |_| Err("Hold release uncertain".into()))
            .await
            .is_err());
        assert!(supervisor.resume_owner("owner").is_err());
        supervisor
            .release_owner_cleanup(&receipt, |_| Ok(()))
            .await
            .unwrap();
        assert!(supervisor.resume_owner("owner").is_ok());
    }

    #[tokio::test]
    async fn cancelled_waiter_keeps_fence_and_retry_waits_for_child_cleanup() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = Arc::new(DelegationSupervisor::new(outbox).unwrap());
        let cancellation = super::super::super::interaction::Cancellation::default();
        let (sender, completion) = tokio::sync::watch::channel(None);
        supervisor.state.lock().unwrap().children.insert(
            Uuid::new_v4(),
            SupervisedChild {
                owner: "owner".into(),
                parent: "parent".into(),
                shutdown: cancellation.clone(),
                completion,
            },
        );
        let request = Uuid::new_v4();
        let worker = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(async move {
                supervisor
                    .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), cancellation.cancelled())
            .await
            .unwrap();
        worker.abort();
        let _ = worker.await;
        assert!(supervisor.resume_owner("owner").is_err());
        sender.send_replace(Some(Ok(())));
        supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .unwrap();
        assert!(supervisor.resume_owner("owner").is_err());
    }

    #[tokio::test]
    async fn stalled_child_cleanup_blocks_only_its_own_owner() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = Arc::new(DelegationSupervisor::new(outbox).unwrap());
        let cancellation = crate::v4_agent::interaction::Cancellation::default();
        let (sender, completion) = tokio::sync::watch::channel(None);
        supervisor.state.lock().unwrap().children.insert(
            Uuid::new_v4(),
            SupervisedChild {
                owner: "alice".into(),
                parent: "parent".into(),
                shutdown: cancellation.clone(),
                completion,
            },
        );
        let request = Uuid::new_v4();
        let first = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move {
                supervisor
                    .acknowledge_owner_cleanup("alice", request, |_| Ok(()))
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), cancellation.cancelled())
            .await
            .unwrap();
        let bob = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            supervisor.acknowledge_owner_cleanup("bob", Uuid::new_v4(), |_| Ok(())),
        )
        .await
        .expect("Alice's child must not block Bob")
        .unwrap();
        supervisor
            .release_owner_cleanup(&bob, |_| Ok(()))
            .await
            .unwrap();
        let mut same = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move {
                supervisor
                    .acknowledge_owner_cleanup("alice", request, |_| Ok(()))
                    .await
            })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut same)
                .await
                .is_err()
        );
        same.abort();
        let _ = same.await;
        sender.send_replace(Some(Ok(())));
        let receipt = first.await.unwrap().unwrap();
        supervisor
            .release_owner_cleanup(&receipt, |_| Ok(()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn replaced_outbox_guard_prevents_acknowledgement_and_release() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let outbox = Arc::new(Outbox::open_or_provision(root.path()).unwrap());
        let supervisor = DelegationSupervisor::new(outbox).unwrap();
        let request = Uuid::new_v4();
        let receipt = supervisor
            .acknowledge_owner_cleanup("owner", request, |_| Ok(()))
            .await
            .unwrap();
        let guard_path = root.path().join("delegation-outbox.guard");
        std::fs::rename(&guard_path, root.path().join("old.guard")).unwrap();
        std::fs::write(&guard_path, b"replacement").unwrap();
        let called = std::sync::atomic::AtomicBool::new(false);
        assert!(supervisor
            .release_owner_cleanup(&receipt, |_| {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(supervisor
            .acknowledge_owner_cleanup("owner", request, |_| {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .is_err());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(supervisor.resume_owner("owner").is_err());
    }
}
