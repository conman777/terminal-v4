use super::*;
use crate::v4_agent::background_process::{
    BackgroundProcesses, BackgroundRequest, BackgroundScope, BackgroundSnapshot,
};

pub(in crate::structured) struct BackgroundTurn {
    manager: StructuredSessionManager,
    background: Arc<BackgroundProcesses>,
    scope: ActionScope,
    generation: u64,
    workspace: PathBuf,
    controller: Arc<V4StructuredController>,
    authority: crate::auth::LocalAuthority,
}

#[derive(Clone, Copy)]
enum Access {
    Status,
    Cancel,
    Output,
}

pub(in crate::structured) struct PreparedStart {
    request: BackgroundRequest,
    incarnation: SessionIncarnation,
    workspace_identity: (u64, u64),
    actor: std::sync::Weak<BackgroundTurn>,
}

pub(in crate::structured) struct ApprovedStart {
    prepared: PreparedStart,
    expires_at: i64,
}

impl StructuredSessionManager {
    pub(crate) fn enable_background_commands(&self) -> Result<(), String> {
        let background = self
            .inner
            .background_processes
            .get()
            .ok_or("Background process manager is unavailable")?;
        tokio::runtime::Handle::try_current()
            .map_err(|_| "Background completion delivery requires an async runtime")?;
        background.enable_commands();
        self.start_background_completion_worker()
    }
}

impl BackgroundTurn {
    pub(in crate::structured) fn new(
        manager: StructuredSessionManager,
        background: Arc<BackgroundProcesses>,
        scope: ActionScope,
        generation: u64,
        workspace: PathBuf,
        controller: Arc<V4StructuredController>,
        authority: crate::auth::LocalAuthority,
    ) -> Result<Self, String> {
        background.validate_actor_binding(&manager.inner.config.data_dir)?;
        if !background.commands_enabled()
            || !manager.live_ownership_enabled()
            || !manager
                .inner
                .background_processes
                .get()
                .is_some_and(|bound| Arc::ptr_eq(bound, &background))
            || !Arc::ptr_eq(&manager.inner, &controller.sink.manager.inner)
            || controller.sink.owner != scope.owner
            || controller.sink.session_id != scope.session_id
            || controller.sink.generation != generation
            || !controller.gate.matches_scope(&scope)
            || authority
                .valid_for(&scope.owner, crate::v4_agent::interaction::now_ms())
                .is_none()
            || generation == 0
            || !workspace.is_absolute()
            || workspace.canonicalize().ok().as_deref() != Some(workspace.as_path())
            || !workspace.is_dir()
        {
            return Err("Trusted background turn is unavailable".into());
        }
        Ok(Self {
            manager,
            background,
            scope,
            generation,
            workspace,
            controller,
            authority,
        })
    }

    fn check_state(
        &self,
        state: &StructuredSessionState,
        expected: Option<SessionIncarnation>,
    ) -> Result<SessionIncarnation, String> {
        let controller: Arc<dyn StructuredProcessController> = self.controller.clone();
        let incarnation = state
            .session_incarnation
            .ok_or("Background action requires a durable session identity")?;
        if state.user_id != self.scope.owner
            || state.id != self.scope.session_id
            || state.generation != self.generation
            || state.deleting
            || state.retiring
            || *self.controller.done.borrow()
            || !state
                .process
                .as_ref()
                .is_some_and(|process| Arc::ptr_eq(process, &controller))
            || !Arc::ptr_eq(&state.resources, &self.controller.resources)
            || Path::new(&state.cwd) != self.workspace
            || expected.is_some_and(|value| value != incarnation)
        {
            return Err("The background turn is no longer active".into());
        }
        Ok(incarnation)
    }

    fn check_request(&self, request: &BackgroundRequest) -> Result<(), String> {
        let (generation, _) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        if request.scope.owner != self.scope.owner
            || request.scope.session != self.scope.session_id
            || request.scope.workspace != self.workspace
            || request.scope.incarnation.is_none()
            || request.authorization_generation != Some(generation)
        {
            return Err("Background request scope changed".into());
        }
        Ok(())
    }

    fn check_checkpoint(&self, expected: SessionIncarnation) -> Result<(), String> {
        let stored = storage::read_for_recovery(
            &self.manager.inner.config,
            &self.scope.owner,
            &self.scope.session_id,
        )?;
        if stored.owner_id != self.scope.owner
            || stored.snapshot.id != self.scope.session_id
            || stored.session_incarnation != Some(expected)
            || Path::new(&stored.snapshot.cwd) != self.workspace
        {
            return Err("Durable background session identity changed".into());
        }
        Ok(())
    }

    fn workspace_identity(&self) -> Result<(u64, u64), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(&self.workspace)
            .map_err(|_| "Background workspace is unavailable")?;
        if !metadata.is_dir()
            || self.workspace.canonicalize().ok().as_deref() != Some(self.workspace.as_path())
        {
            return Err("Background workspace changed".into());
        }
        Ok((metadata.dev(), metadata.ino()))
    }

    fn check_workspace_identity(&self, expected: (u64, u64)) -> Result<(), String> {
        if self.workspace_identity()? != expected {
            return Err("Background workspace changed after preparation".into());
        }
        Ok(())
    }

    pub(in crate::structured) async fn prepare(
        self: &Arc<Self>,
        request: &BackgroundRequest,
    ) -> Result<PreparedStart, String> {
        self.check_request(request)?;
        self.background
            .validate_actor_binding(&self.manager.inner.config.data_dir)?;
        self.controller.cancel.check()?;
        self.background.ensure_session_open(&request.scope).await?;
        self.background.ensure_capacity(&request.scope).await?;
        let session = self
            .manager
            .owned_session(&self.scope.owner, &self.scope.session_id)
            .await?
            .ok_or("Session not found")?;
        self.manager.validate_live_owner(&self.scope.owner)?;
        let _lifecycle = session
            .lifecycle
            .try_lock()
            .map_err(|_| "Session is busy; retry background action")?;
        let _boundary =
            crate::v4_agent::background_process::bootstrap::SessionBoundary::try_session(
                &self.manager.inner.config.data_dir,
                &self.scope.owner,
                &self.scope.session_id,
            )?;
        let state = session
            .state
            .try_lock()
            .map_err(|_| "Session is busy; retry background action")?;
        let incarnation = self.check_state(&state, None)?;
        if request.scope.incarnation != Some(incarnation.0) {
            return Err("Background session identity changed".into());
        }
        drop(state);
        self.check_checkpoint(incarnation)?;
        self.controller.cancel.check()?;
        let workspace_identity = self.workspace_identity()?;
        Ok(PreparedStart {
            request: request.clone(),
            incarnation,
            workspace_identity,
            actor: Arc::downgrade(self),
        })
    }

    async fn access(
        &self,
        action_id: &str,
        mode: Access,
    ) -> Result<(BackgroundScope, BackgroundSnapshot), String> {
        if action_id.len() != 64
            || !action_id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err("Invalid background action ID".into());
        }
        self.background
            .validate_actor_binding(&self.manager.inner.config.data_dir)?;
        let (generation, expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        self.controller.cancel.check()?;
        let session = self
            .manager
            .owned_session(&self.scope.owner, &self.scope.session_id)
            .await?
            .ok_or("Session not found")?;
        self.manager.validate_live_owner(&self.scope.owner)?;
        let _lifecycle = session
            .lifecycle
            .try_lock()
            .map_err(|_| "Session is busy; retry background action")?;
        let _boundary =
            crate::v4_agent::background_process::bootstrap::SessionBoundary::try_session(
                &self.manager.inner.config.data_dir,
                &self.scope.owner,
                &self.scope.session_id,
            )?;
        let state = session
            .state
            .try_lock()
            .map_err(|_| "Session is busy; retry background action")?;
        let incarnation = self.check_state(&state, None)?;
        self.check_checkpoint(incarnation)?;
        self.workspace_identity()?;
        let scope = BackgroundScope {
            owner: self.scope.owner.clone(),
            session: self.scope.session_id.clone(),
            workspace: self.workspace.clone(),
            incarnation: Some(incarnation.0),
        };
        let snapshot = if matches!(mode, Access::Output) {
            self.background.output_for_actor(
                &scope,
                action_id,
                generation,
                expiry,
                &self.controller.cancel,
            )?
        } else {
            self.background.access_for_actor(
                &scope,
                action_id,
                generation,
                expiry,
                &self.controller.cancel,
                matches!(mode, Access::Cancel),
            )?
        };
        Ok((scope, snapshot))
    }

    pub(in crate::structured) async fn status(
        &self,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        self.access(action_id, Access::Status)
            .await
            .map(|(_, snapshot)| snapshot)
    }

    pub(in crate::structured) async fn cancel(
        &self,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        self.access(action_id, Access::Cancel)
            .await
            .map(|(_, snapshot)| snapshot)
    }

    pub(in crate::structured) async fn wait(
        &self,
        action_id: &str,
        timeout: std::time::Duration,
    ) -> Result<BackgroundSnapshot, String> {
        let (scope, snapshot) = self.access(action_id, Access::Status).await?;
        if !matches!(
            snapshot.state,
            crate::v4_agent::background_process::BackgroundState::Running
        ) {
            return Ok(snapshot);
        }
        let waited = self
            .background
            .wait(&scope, action_id, timeout, &self.controller.cancel)
            .await;
        let current = self.status(action_id).await?;
        waited?;
        Ok(current)
    }

    pub(in crate::structured) async fn approve(
        self: &Arc<Self>,
        prepared: PreparedStart,
        call_id: &str,
    ) -> Result<ApprovedStart, String> {
        if !prepared
            .actor
            .upgrade()
            .is_some_and(|actor| Arc::ptr_eq(self, &actor))
            || call_id.is_empty()
            || call_id.len() > 512
            || call_id.contains('\0')
            || prepared.request.action_id
                != crate::v4_agent::background_process::tool::action_id(&self.scope, call_id)
            || prepared.request.command.is_empty()
            || prepared.request.command.len() > 10_000
            || prepared.request.command.contains('\0')
            || prepared.request.timeout.is_zero()
            || prepared.request.timeout > std::time::Duration::from_secs(86400)
            || prepared.request.timeout.subsec_nanos() != 0
            || prepared.request.action_id.is_empty()
            || prepared.request.action_id.len() > 128
        {
            return Err("Invalid prepared background action".into());
        }
        self.check_request(&prepared.request)?;
        self.background
            .validate_actor_binding(&self.manager.inner.config.data_dir)?;
        self.check_workspace_identity(prepared.workspace_identity)?;
        self.controller.cancel.check()?;
        let (_, credential_expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        let expires_at = crate::v4_agent::interaction::now_ms()
            .saturating_add(300_000)
            .min(credential_expiry);
        let input = serde_json::json!({"command": prepared.request.command, "timeoutSeconds": prepared.request.timeout.as_secs()});
        let approval = ApprovalRequest {
            id: Uuid::new_v4().to_string(), scope: self.scope.clone(), tool_call_id: call_id.into(),
            tool_name: "background_start".into(), tool_input: input,
            description: format!("Background command (runs on this host; continues after this turn)\nWorkspace: {}\nAction ID: {}\nTimeout: {} seconds\nCommand:\n{}", self.workspace.display(), prepared.request.action_id, prepared.request.timeout.as_secs(), prepared.request.command),
            expires_at,
        };
        if !self
            .controller
            .gate
            .wait(
                approval,
                self.controller.sink.as_ref(),
                &self.controller.cancel,
            )
            .await?
        {
            return Err("User denied this exact background action".into());
        }
        self.controller.cancel.check()?;
        if expires_at <= crate::v4_agent::interaction::now_ms() {
            return Err("Exact, unexpired background approval is required".into());
        }
        Ok(ApprovedStart {
            prepared,
            expires_at,
        })
    }

    pub(in crate::structured) async fn start_approved(
        self: &Arc<Self>,
        approval: ApprovedStart,
    ) -> Result<BackgroundSnapshot, String> {
        let ApprovedStart {
            prepared,
            expires_at,
        } = approval;
        let (_, credential_expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        if !prepared
            .actor
            .upgrade()
            .is_some_and(|actor| Arc::ptr_eq(self, &actor))
            || expires_at <= crate::v4_agent::interaction::now_ms()
            || expires_at > credential_expiry
        {
            return Err("Exact, unexpired background approval is required".into());
        }
        let actor = Arc::clone(self);
        tokio::spawn(async move {
            actor.check_request(&prepared.request)?;
            actor
                .background
                .validate_actor_binding(&actor.manager.inner.config.data_dir)?;
            actor.controller.cancel.check()?;
            let session = actor
                .manager
                .owned_session(&actor.scope.owner, &actor.scope.session_id)
                .await?
                .ok_or("Session not found")?;
            actor.manager.validate_live_owner(&actor.scope.owner)?;
            let _lifecycle = session
                .lifecycle
                .try_lock()
                .map_err(|_| "Session is busy; retry background action")?;
            let _boundary =
                crate::v4_agent::background_process::bootstrap::SessionBoundary::try_session(
                    &actor.manager.inner.config.data_dir,
                    &actor.scope.owner,
                    &actor.scope.session_id,
                )?;
            let state = session
                .state
                .try_lock()
                .map_err(|_| "Session is busy; retry background action")?;
            actor.check_state(&state, Some(prepared.incarnation))?;
            drop(state);
            actor.check_checkpoint(prepared.incarnation)?;
            actor.check_workspace_identity(prepared.workspace_identity)?;
            actor.controller.cancel.check()?;
            let live = session.session.clone();
            let checked = actor.clone();
            let incarnation = prepared.incarnation;
            let workspace_identity = prepared.workspace_identity;
            let approved = prepared.request.clone();
            actor
                .background
                .start_for_actor(
                    prepared.request,
                    &approved,
                    &actor.controller.cancel,
                    expires_at,
                    move |command| {
                        let state = live
                            .state
                            .try_lock()
                            .map_err(|_| "Session changed before background launch")?;
                        checked.check_state(&state, Some(incarnation))?;
                        checked.check_workspace_identity(workspace_identity)?;
                        command
                            .spawn()
                            .map_err(|_| "Cannot start background process".into())
                    },
                )
                .await
        })
        .await
        .map_err(|_| "Background start outcome is uncertain".to_string())?
    }
}

impl BackgroundTurn {
    async fn start_checked_tool(
        self: Arc<Self>,
        call_id: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<(String, BackgroundSnapshot), String> {
        let (generation, _) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        let session = self
            .manager
            .owned_session(&self.scope.owner, &self.scope.session_id)
            .await?
            .ok_or("Session not found")?;
        let incarnation = session
            .state
            .lock()
            .await
            .session_incarnation
            .ok_or("Background action requires a durable session identity")?;
        let request = BackgroundRequest {
            scope: BackgroundScope {
                owner: self.scope.owner.clone(),
                session: self.scope.session_id.clone(),
                workspace: self.workspace.clone(),
                incarnation: Some(incarnation.0),
            },
            authorization_generation: Some(generation),
            action_id: crate::v4_agent::background_process::tool::action_id(&self.scope, call_id),
            command: command.into(),
            timeout,
        };
        let prepared = self.prepare(&request).await?;
        let approved = self.approve(prepared, call_id).await?;
        let snapshot = self.start_approved(approved).await?;
        Ok((request.action_id, snapshot))
    }

    async fn review_output_checked(
        &self,
        call_id: &str,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        if call_id.is_empty() || call_id.len() > 512 || call_id.contains('\0') {
            return Err("Invalid background output review".into());
        }
        let (_, snapshot) = self.access(action_id, Access::Output).await?;
        let (_, credential_expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        let expires_at = crate::v4_agent::interaction::now_ms()
            .saturating_add(300_000)
            .min(credential_expiry);
        let reviewed = serde_json::json!({
            "actionId": action_id,
            "stdout": snapshot.stdout,
            "stderr": snapshot.stderr,
            "stdoutTruncated": snapshot.stdout_truncated,
            "stderrTruncated": snapshot.stderr_truncated,
        });
        let approval = ApprovalRequest {
            id: Uuid::new_v4().to_string(),
            scope: self.scope.clone(),
            tool_call_id: call_id.into(),
            tool_name: "background_read_output".into(),
            tool_input: serde_json::json!({"actionId": action_id}),
            description: format!(
                "Share this exact background command output with the agent? It may contain sensitive information.\nWorkspace: {}\n{}",
                self.workspace.display(),
                serde_json::to_string_pretty(&reviewed).map_err(|_| "Cannot encode output")?
            ),
            expires_at,
        };
        if !self
            .controller
            .gate
            .wait(
                approval,
                self.controller.sink.as_ref(),
                &self.controller.cancel,
            )
            .await?
        {
            return Err("User denied releasing background output".into());
        }
        self.controller.cancel.check()?;
        if crate::v4_agent::interaction::now_ms() >= expires_at {
            return Err("Output approval expired".into());
        }
        // Re-fence immediately before release; only the reviewed bytes are returned.
        self.access(action_id, Access::Output).await?;
        Ok(snapshot)
    }
}

#[async_trait::async_trait]
impl crate::v4_agent::background_process::tool::BackgroundActor for BackgroundTurn {
    fn scope(&self) -> &ActionScope {
        &self.scope
    }
    async fn start(
        self: Arc<Self>,
        call_id: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<(String, BackgroundSnapshot), String> {
        self.start_checked_tool(call_id, command, timeout).await
    }
    async fn status(&self, action_id: &str) -> Result<BackgroundSnapshot, String> {
        BackgroundTurn::status(self, action_id).await
    }
    async fn wait(
        &self,
        action_id: &str,
        timeout: std::time::Duration,
    ) -> Result<BackgroundSnapshot, String> {
        BackgroundTurn::wait(self, action_id, timeout).await
    }
    async fn cancel(&self, action_id: &str) -> Result<BackgroundSnapshot, String> {
        BackgroundTurn::cancel(self, action_id).await
    }
    async fn review_output(
        &self,
        call_id: &str,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        self.review_output_checked(call_id, action_id).await
    }
}
