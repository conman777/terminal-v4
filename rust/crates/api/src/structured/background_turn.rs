use super::*;
use crate::v4_agent::background_process::{
    BackgroundProcesses, BackgroundRequest, BackgroundScope, BackgroundSnapshot,
    InputAuthorization, OutputQuery, OutputWindow,
};

pub(in crate::structured) struct BackgroundTurn {
    manager: StructuredSessionManager,
    background: Arc<BackgroundProcesses>,
    scope: ActionScope,
    generation: u64,
    workspace: PathBuf,
    controller: Arc<V4StructuredController>,
    authority: crate::auth::LocalAuthority,
    instance: Uuid,
}

#[derive(Clone, Copy)]
enum Access {
    Status,
    Cancel,
    #[allow(dead_code)] // Reserved for a private, non-persistent review surface.
    Output,
}

#[derive(Clone, Copy)]
enum InputRequest<'a> {
    Write(&'a str),
    Binary { bytes: &'a [u8], encoded: &'a str },
    Close,
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

pub(in crate::structured) struct PreparedOutput {
    actor: Uuid,
    scope: BackgroundScope,
    action_id: String,
    call_id: String,
    workspace_identity: (u64, u64),
    snapshot: BackgroundSnapshot,
    window: OutputWindow,
}

pub(in crate::structured) struct ApprovedOutput {
    prepared: PreparedOutput,
    expires_at: i64,
}

fn approval_literal(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .chars()
            .flat_map(char::escape_default)
            .collect::<String>()
    )
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
        background.try_enable_commands()?;
        self.start_background_completion_worker()
    }

    fn private_review_authority(
        &self,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        app: &crate::state::AppState,
    ) -> Result<DecisionAuthority, StructuredControlError> {
        let manager_root = self.inner.config.data_dir.canonicalize().map_err(|_| {
            StructuredControlError::internal("Private review authority unavailable")
        })?;
        let app_root = app.config().data_dir.canonicalize().map_err(|_| {
            StructuredControlError::internal("Private review authority unavailable")
        })?;
        if manager_root != app_root {
            return Err(StructuredControlError::internal(
                "Private review authority scope mismatch",
            ));
        }
        match (local, paired) {
            (Some(local), None) => Ok(DecisionAuthority::Local(local.clone())),
            (None, Some(paired)) => Ok(DecisionAuthority::Paired(paired.clone())),
            _ => Err(StructuredControlError::conflict(
                "Private review authority is unavailable",
            )),
        }
    }

    async fn private_review_context(
        &self,
        owner: String,
        authority: DecisionAuthority,
        app: crate::state::AppState,
    ) -> Result<PairedDecisionContext, StructuredControlError> {
        let guard_app = app.clone();
        let guard_owner = owner.clone();
        let guard = tokio::task::spawn_blocking(move || {
            let guard = guard_app.acquire_input_guard(&guard_owner)?;
            guard_app.verify_owner_input_guard(&guard)?;
            Ok::<_, String>(guard)
        })
        .await
        .map_err(|_| StructuredControlError::internal("Private review admission unavailable"))?
        .map_err(StructuredControlError::internal)?;
        let context = PairedDecisionContext {
            guard: Arc::new(guard),
            state: app,
            authority,
            owner,
        };
        context.check().map_err(StructuredControlError::conflict)?;
        self.validate_live_owner(&context.owner)
            .map_err(StructuredControlError::internal)?;
        Ok(context)
    }

    pub(crate) async fn preview_private_output(
        &self,
        owner: &str,
        session_id: &str,
        approval_id: &str,
        action_id: &str,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        app: &crate::state::AppState,
    ) -> Result<(String, Value), StructuredControlError> {
        let authority = self.private_review_authority(local, paired, app)?;
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let permit = self
            .inner
            .legacy_input_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| StructuredControlError::conflict("Review capacity is busy; try again"))?;
        let manager = self.clone();
        let app = app.clone();
        let owner = owner.to_owned();
        let approval_id = approval_id.to_owned();
        let action_id = action_id.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            let context = manager
                .private_review_context(owner, authority, app)
                .await?;
            let state = session.state.try_lock().map_err(|_| {
                StructuredControlError::conflict("Session is busy; retry private review")
            })?;
            if state.deleting || state.retiring {
                return Err(StructuredControlError::conflict(
                    "Session is no longer active",
                ));
            }
            let process = state.process.clone().ok_or_else(|| {
                StructuredControlError::conflict("Private output review is no longer pending")
            })?;
            drop(state);
            process
                .private_output_preview(&approval_id, &action_id, &context)
                .await
                .map_err(StructuredControlError::conflict)
        })
        .await
        .map_err(|_| StructuredControlError::internal("Private review preview is unavailable"))?
    }

    pub(crate) async fn decide_private_output(
        &self,
        owner: &str,
        session_id: &str,
        approval_id: &str,
        action_id: &str,
        token: &str,
        local: Option<&crate::auth::LocalAuthority>,
        paired: Option<&crate::auth::PairedInputAuthority>,
        app: &crate::state::AppState,
    ) -> Result<DecisionReceipt, StructuredControlError> {
        let authority = self.private_review_authority(local, paired, app)?;
        let session = self
            .owned_session(owner, session_id)
            .await
            .map_err(StructuredControlError::internal)?
            .ok_or_else(StructuredControlError::not_found)?;
        let permit = self
            .inner
            .legacy_input_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                StructuredControlError::conflict("Approval capacity is busy; try again")
            })?;
        let manager = self.clone();
        let app = app.clone();
        let owner = owner.to_owned();
        let approval_id = approval_id.to_owned();
        let action_id = action_id.to_owned();
        let token = token.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            let context = manager
                .private_review_context(owner, authority, app)
                .await?;
            let state = session.state.try_lock().map_err(|_| {
                StructuredControlError::conflict("Session is busy; retry private review")
            })?;
            if state.deleting || state.retiring {
                return Err(StructuredControlError::conflict(
                    "Session is no longer active",
                ));
            }
            let process = state.process.clone().ok_or_else(|| {
                StructuredControlError::conflict("Private output review is no longer pending")
            })?;
            drop(state);
            process
                .private_output_decision(&approval_id, &action_id, &token, &context)
                .await
                .map_err(StructuredControlError::conflict)
        })
        .await
        .map_err(|_| StructuredControlError::internal("Private review outcome is uncertain"))?
    }
}

impl BackgroundTurn {
    fn local_admission(&self) -> Result<&crate::state::LocalAdmission, String> {
        self.manager
            .inner
            .local_admission
            .get()
            .ok_or_else(|| "Background authorization is unavailable".into())
    }
    #[cfg(test)]
    pub(in crate::structured) fn review_origin_for_test(&self) -> Uuid {
        self.instance
    }
    #[cfg(test)]
    pub(in crate::structured) fn review_workspace_for_test(&self) -> (u64, u64) {
        self.workspace_identity().unwrap()
    }

    #[cfg(test)]
    pub(in crate::structured) fn with_test_authority(
        &self,
        authority: crate::auth::LocalAuthority,
    ) -> Self {
        Self {
            manager: self.manager.clone(),
            background: self.background.clone(),
            scope: self.scope.clone(),
            generation: self.generation,
            workspace: self.workspace.clone(),
            controller: self.controller.clone(),
            authority,
            instance: self.instance,
        }
    }

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
            || authority.auth_protocol() != 0
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
            instance: Uuid::new_v4(),
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
        self.with_authorized_scope(|scope, generation, expiry| {
            let snapshot = if matches!(mode, Access::Output) {
                self.background.output_for_actor(
                    scope,
                    action_id,
                    generation,
                    expiry,
                    &self.controller.cancel,
                    &self.authority,
                    self.local_admission()?,
                )?
            } else {
                self.background.access_for_actor_authorized(
                    scope,
                    action_id,
                    generation,
                    expiry,
                    &self.controller.cancel,
                    matches!(mode, Access::Cancel),
                    &self.authority,
                    self.local_admission()?,
                )?
            };
            Ok((scope.clone(), snapshot))
        })
        .await
    }

    async fn with_authorized_scope<T>(
        &self,
        action: impl FnOnce(&BackgroundScope, i64, i64) -> Result<T, String> + Send,
    ) -> Result<T, String> {
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
        action(&scope, generation, expiry)
    }

    pub(in crate::structured) async fn prepare_output(
        &self,
        action_id: &str,
        call_id: &str,
    ) -> Result<PreparedOutput, String> {
        self.prepare_output_window(action_id, call_id, OutputWindow::Head)
            .await
    }

    async fn prepare_output_window(
        &self,
        action_id: &str,
        call_id: &str,
        window: OutputWindow,
    ) -> Result<PreparedOutput, String> {
        if action_id.len() != 64
            || !action_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || call_id.is_empty()
            || call_id.len() > 512
            || call_id.contains('\0')
        {
            return Err("Invalid private output review".into());
        }
        self.with_authorized_scope(|scope, generation, expiry| {
            let workspace_identity = self.workspace_identity()?;
            let snapshot = self.background.with_output_window_for_actor(
                OutputQuery {
                    scope,
                    action_id,
                    window,
                },
                generation,
                expiry,
                &self.controller.cancel,
                &self.authority,
                self.local_admission()?,
                Ok,
            )?;
            Ok(PreparedOutput {
                actor: self.instance,
                scope: scope.clone(),
                action_id: action_id.into(),
                call_id: call_id.into(),
                workspace_identity,
                snapshot,
                window,
            })
        })
        .await
    }

    #[cfg(test)]
    pub(in crate::structured) async fn private_output_preview(
        &self,
        approval_id: &str,
        action_id: &str,
        reviewer: &crate::auth::LocalAuthority,
    ) -> Result<(String, Value), String> {
        self.with_authorized_scope(|scope, generation, origin_expiry| {
            let workspace_identity = self.workspace_identity()?;
            let (reviewer_generation, reviewer_expiry) = reviewer
                .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Private review authorization is unavailable or expired")?;
            if reviewer_generation != generation {
                return Err("Private review authorization has changed".into());
            }
            let check = || {
                reviewer
                    .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
                    .filter(|(current, _)| *current == generation)
                    .map(|_| ())
                    .ok_or_else(|| "Private review authorization is unavailable or expired".into())
            };
            self.background.with_output_for_actor(
                scope,
                action_id,
                generation,
                origin_expiry.min(reviewer_expiry),
                &self.controller.cancel,
                &self.authority,
                self.local_admission()?,
                |_| {
                    self.controller.gate.try_private_output_preview_checked(
                        approval_id,
                        action_id,
                        self.instance,
                        workspace_identity,
                        &check,
                    )
                },
            )
        })
        .await
    }

    async fn private_output_preview_with_context(
        &self,
        approval_id: &str,
        action_id: &str,
        context: &PairedDecisionContext,
    ) -> Result<(String, Value), String> {
        let review_root = context
            .state
            .config()
            .data_dir
            .canonicalize()
            .map_err(|_| "Private review authority is unavailable")?;
        let actor_root = self
            .manager
            .inner
            .config
            .data_dir
            .canonicalize()
            .map_err(|_| "Private review authority is unavailable")?;
        if context.owner != self.scope.owner
            || review_root != actor_root
            || !context.guard.matches_scope(&actor_root, &self.scope.owner)
        {
            return Err("Private review authority does not match the session".into());
        }
        let reviewer_expiry = context.check()?;
        let (origin_generation, _) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        context
            .state
            .with_owner_review(&self.scope.owner, &self.authority, |_, check| check())?;
        let result = self
            .with_authorized_scope(|scope, generation, origin_expiry| {
                if generation != origin_generation {
                    return Err("Background authorization has changed".into());
                }
                let workspace_identity = self.workspace_identity()?;
                let check = || {
                    if crate::v4_agent::interaction::now_ms() >= reviewer_expiry {
                        return Err("Private review authorization expired".into());
                    }
                    self.authority
                        .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
                        .filter(|(current, _)| *current == generation)
                        .map(|_| ())
                        .ok_or_else(|| "Background authorization is unavailable or expired".into())
                };
                self.background.with_output_for_actor(
                    scope,
                    action_id,
                    generation,
                    origin_expiry.min(reviewer_expiry),
                    &self.controller.cancel,
                    &self.authority,
                    self.local_admission()?,
                    |_| {
                        self.controller.gate.try_private_output_preview_checked(
                            approval_id,
                            action_id,
                            self.instance,
                            workspace_identity,
                            &check,
                        )
                    },
                )
            })
            .await?;
        context.check()?;
        Ok(result)
    }

    pub(in crate::structured) async fn private_output_decision(
        &self,
        approval_id: &str,
        action_id: &str,
        token: &str,
        context: &PairedDecisionContext,
    ) -> Result<DecisionReceipt, String> {
        let review_root = context
            .state
            .config()
            .data_dir
            .canonicalize()
            .map_err(|_| "Private review authority is unavailable")?;
        let actor_root = self
            .manager
            .inner
            .config
            .data_dir
            .canonicalize()
            .map_err(|_| "Private review authority is unavailable")?;
        if context.owner != self.scope.owner
            || review_root != actor_root
            || !context.guard.matches_scope(&actor_root, &self.scope.owner)
        {
            return Err("Private review authority does not match the session".into());
        }
        let reviewer_expiry = context.check()?;
        let (generation, origin_expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        context
            .state
            .with_owner_review(&self.scope.owner, &self.authority, |_, check| check())?;
        self.background
            .validate_actor_binding(&self.manager.inner.config.data_dir)?;
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
            .map_err(|_| "Session is busy; retry private review")?;
        let _boundary =
            crate::v4_agent::background_process::bootstrap::SessionBoundary::try_session(
                &self.manager.inner.config.data_dir,
                &self.scope.owner,
                &self.scope.session_id,
            )?;
        let state = session
            .state
            .try_lock()
            .map_err(|_| "Session is busy; retry private review")?;
        let incarnation = self.check_state(&state, None)?;
        self.check_checkpoint(incarnation)?;
        let workspace_identity = self.workspace_identity()?;
        let scope = BackgroundScope {
            owner: self.scope.owner.clone(),
            session: self.scope.session_id.clone(),
            workspace: self.workspace.clone(),
            incarnation: Some(incarnation.0),
        };
        let expires_at = reviewer_expiry.min(origin_expiry);
        self.background.with_output_for_actor(
            &scope,
            action_id,
            generation,
            expires_at,
            &self.controller.cancel,
            &self.authority,
            self.local_admission()?,
            |_| Ok(()),
        )?;
        drop(state);
        let check = || {
            if !context.guard.matches_scope(&actor_root, &self.scope.owner) {
                return Err("Private review authority does not match the session".into());
            }
            self.background.validate_actor_binding(&actor_root)?;
            self.manager.validate_live_owner(&self.scope.owner)?;
            context.check()?;
            let (current, _) = self
                .authority
                .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
                .ok_or("Background authorization is unavailable or expired")?;
            if current != generation {
                return Err("Background authorization has changed".into());
            }
            context
                .state
                .with_owner_review(&self.scope.owner, &self.authority, |_, check| check())?;
            self.check_workspace_identity(workspace_identity)?;
            self.controller.cancel.check()
        };
        let sink = PairedDecisionSink {
            sink: self.controller.sink.as_ref(),
            expires_at,
        };
        self.controller
            .gate
            .decide_private_output_with_expiry(
                approval_id,
                action_id,
                token,
                self.instance,
                workspace_identity,
                &sink,
                expires_at,
                &check,
            )
            .await
    }

    pub(in crate::structured) async fn approve_output(
        &self,
        prepared: PreparedOutput,
    ) -> Result<ApprovedOutput, String> {
        if prepared.actor != self.instance {
            return Err("Private output review belongs to a different turn".into());
        }
        self.with_authorized_scope(|scope, generation, expiry| {
            if scope != &prepared.scope {
                return Err("Private output session identity changed".into());
            }
            self.check_workspace_identity(prepared.workspace_identity)?;
            self.background.with_output_for_actor(
                scope,
                &prepared.action_id,
                generation,
                expiry,
                &self.controller.cancel,
                &self.authority,
                self.local_admission()?,
                |_| Ok(()),
            )
        })
        .await?;
        self.controller.cancel.check()?;
        let (_, credential_expiry) = self
            .authority
            .valid_for(&self.scope.owner, crate::v4_agent::interaction::now_ms())
            .ok_or("Background authorization is unavailable or expired")?;
        let expires_at = crate::v4_agent::interaction::now_ms()
            .saturating_add(300_000)
            .min(credential_expiry);
        let request = ApprovalRequest {
            id: Uuid::new_v4().to_string(),
            scope: self.scope.clone(),
            tool_call_id: prepared.call_id.clone(),
            tool_name: "background_read_output".into(),
            tool_input: serde_json::json!({"actionId": prepared.action_id}),
            description: String::new(),
            expires_at,
        };
        let snapshot = serde_json::json!({
            "actionId": prepared.action_id,
            "stdout": prepared.snapshot.stdout,
            "stderr": prepared.snapshot.stderr,
            "stdoutTruncated": prepared.snapshot.stdout_truncated,
            "stderrTruncated": prepared.snapshot.stderr_truncated,
            "window": if prepared.window == OutputWindow::Tail { "tail" } else { "head" },
        });
        if !self
            .controller
            .gate
            .wait_private_output_bound(
                request,
                snapshot,
                self.instance,
                prepared.workspace_identity,
                self.controller.sink.as_ref(),
                &self.controller.cancel,
            )
            .await?
        {
            return Err("User denied releasing background output".into());
        }
        self.controller.cancel.check()?;
        if expires_at <= crate::v4_agent::interaction::now_ms() {
            return Err("Private output approval expired".into());
        }
        Ok(ApprovedOutput {
            prepared,
            expires_at,
        })
    }

    pub(in crate::structured) async fn release_output(
        &self,
        approved: ApprovedOutput,
    ) -> Result<BackgroundSnapshot, String> {
        let PreparedOutput {
            actor,
            scope: reviewed_scope,
            action_id,
            workspace_identity,
            snapshot,
            ..
        } = approved.prepared;
        if actor != self.instance {
            return Err("Private output review belongs to a different turn".into());
        }
        self.with_authorized_scope(|scope, generation, credential_expiry| {
            if scope != &reviewed_scope {
                return Err("Private output session identity changed".into());
            }
            self.check_workspace_identity(workspace_identity)?;
            let expires_at = approved.expires_at.min(credential_expiry);
            self.background.with_output_for_actor(
                scope,
                &action_id,
                generation,
                expires_at,
                &self.controller.cancel,
                &self.authority,
                self.local_admission()?,
                |_| Ok(snapshot),
            )
        })
        .await
    }

    pub(in crate::structured) async fn list(
        &self,
    ) -> Result<Vec<(String, BackgroundSnapshot)>, String> {
        self.with_authorized_scope(|scope, generation, expiry| {
            self.background.list_for_actor_authorized(
                scope,
                generation,
                expiry,
                &self.controller.cancel,
                &self.authority,
                self.local_admission()?,
            )
        })
        .await
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

    pub(in crate::structured) async fn wait_output(
        &self,
        action_id: &str,
        after_revision: u64,
        timeout: std::time::Duration,
    ) -> Result<(BackgroundSnapshot, u64), String> {
        let (scope, _) = self.access(action_id, Access::Status).await?;
        let revision = self
            .background
            .wait_output_revision(
                &scope,
                action_id,
                after_revision,
                timeout,
                &self.controller.cancel,
            )
            .await?;
        let snapshot = self.status(action_id).await?;
        Ok((snapshot, revision))
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
        let mut input = serde_json::json!({"command": prepared.request.command, "timeoutSeconds": prepared.request.timeout.as_secs()});
        let interactive_note = if prepared.request.interactive {
            input["interactive"] = serde_json::json!(true);
            "\nInteractive input: enabled; later input requires separate approval"
        } else {
            ""
        };
        let display_command = if prepared.request.interactive {
            approval_literal(&prepared.request.command)
        } else {
            prepared.request.command.clone()
        };
        let display_workspace = if prepared.request.interactive {
            approval_literal(&self.workspace.to_string_lossy())
        } else {
            self.workspace.display().to_string()
        };
        let approval = ApprovalRequest {
            id: Uuid::new_v4().to_string(), scope: self.scope.clone(), tool_call_id: call_id.into(),
            tool_name: "background_start".into(), tool_input: input,
            description: format!("Background command (runs on this host; continues after this turn)\nWorkspace: {}\nAction ID: {}\nTimeout: {} seconds{}\nCommand{}:\n{}", display_workspace, prepared.request.action_id, prepared.request.timeout.as_secs(), interactive_note, if prepared.request.interactive { " (escaped)" } else { "" }, display_command),
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
        interactive: bool,
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
            interactive,
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
        let prepared = self.prepare_output(action_id, call_id).await?;
        let approved = self.approve_output(prepared).await?;
        self.release_output(approved).await
    }

    async fn follow_output_checked(
        &self,
        call_id: &str,
        action_id: &str,
        after_revision: u64,
        timeout: std::time::Duration,
    ) -> Result<(BackgroundSnapshot, u64, Option<BackgroundSnapshot>), String> {
        let (status, revision) = self.wait_output(action_id, after_revision, timeout).await?;
        if revision == after_revision {
            return Ok((status, revision, None));
        }
        let prepared = self
            .prepare_output_window(action_id, call_id, OutputWindow::Tail)
            .await?;
        let approved = self.approve_output(prepared).await?;
        let released = self.release_output(approved).await?;
        let status = self.status(action_id).await?;
        Ok((status, revision, Some(released)))
    }

    async fn input_operation_checked(
        &self,
        call_id: &str,
        action_id: &str,
        operation: InputRequest<'_>,
    ) -> Result<(), String> {
        if call_id.is_empty()
            || call_id.len() > 512
            || call_id.contains('\0')
            || action_id.len() != 64
            || !action_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || match operation {
                InputRequest::Write(text) => {
                    text.is_empty()
                        || text.len() > crate::v4_agent::background_process::BACKGROUND_INPUT_LIMIT
                }
                InputRequest::Binary { bytes, .. } => {
                    bytes.is_empty()
                        || bytes.len() > crate::v4_agent::background_process::BACKGROUND_INPUT_LIMIT
                }
                InputRequest::Close => false,
            }
        {
            return Err("Invalid background input".into());
        }
        let (prepared_scope, prepared_generation, credential_expiry, workspace_identity, command) =
            self.with_authorized_scope(|scope, generation, expiry| {
                let auth = InputAuthorization {
                    generation,
                    expires_at: expiry,
                    cancellation: &self.controller.cancel,
                };
                let command = self.background.ensure_input_for_actor_authorized(
                    scope,
                    action_id,
                    &auth,
                    &self.authority,
                    self.local_admission()?,
                )?;
                Ok((
                    scope.clone(),
                    generation,
                    expiry,
                    self.workspace_identity()?,
                    command,
                ))
            })
            .await?;
        let expires_at = crate::v4_agent::interaction::now_ms()
            .saturating_add(300_000)
            .min(credential_expiry);
        let operation_id =
            crate::v4_agent::background_process::tool::action_id(&self.scope, call_id);
        let rendered_command = approval_literal(&command);
        let rendered_workspace = approval_literal(&self.workspace.to_string_lossy());
        let (tool_name, tool_input, description) = match operation {
            InputRequest::Write(text) => (
                "background_write",
                serde_json::json!({"actionId": action_id, "text": text}),
                format!("Write interactive input to a running background command\nWorkspace (escaped): {}\nAction ID: {}\nCommand (escaped):\n{}\nExact text (escaped):\n{}", rendered_workspace, action_id, rendered_command, approval_literal(text)),
            ),
            InputRequest::Binary { bytes, encoded } => (
                "background_write_bytes",
                serde_json::json!({"actionId": action_id, "base64": encoded}),
                format!("Write binary input to a running background command\nWorkspace (escaped): {}\nAction ID: {}\nCommand (escaped):\n{}\nExact bytes (hexadecimal):\n{}", rendered_workspace, action_id, rendered_command, bytes.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" ")),
            ),
            InputRequest::Close => (
                "background_close_input",
                serde_json::json!({"actionId": action_id}),
                format!("Close interactive input to a running background command (send end-of-file)\nWorkspace (escaped): {}\nAction ID: {}\nCommand (escaped):\n{}", rendered_workspace, action_id, rendered_command),
            ),
        };
        let approval = ApprovalRequest {
            id: Uuid::new_v4().to_string(),
            scope: self.scope.clone(),
            tool_call_id: call_id.into(),
            tool_name: tool_name.into(),
            tool_input,
            description,
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
            return Err("User denied this exact background input".into());
        }
        self.with_authorized_scope(|scope, generation, current_expiry| {
            if scope != &prepared_scope || generation != prepared_generation {
                return Err("Background input authorization has changed".into());
            }
            self.check_workspace_identity(workspace_identity)?;
            let auth = InputAuthorization {
                generation,
                expires_at: expires_at.min(current_expiry),
                cancellation: &self.controller.cancel,
            };
            match operation {
                InputRequest::Write(text) => self.background.write_input_for_actor_authorized(
                    scope,
                    action_id,
                    &operation_id,
                    text.as_bytes(),
                    &command,
                    &auth,
                    &self.authority,
                    self.local_admission()?,
                ),
                InputRequest::Binary { bytes, .. } => {
                    self.background.write_input_for_actor_authorized(
                        scope,
                        action_id,
                        &operation_id,
                        bytes,
                        &command,
                        &auth,
                        &self.authority,
                        self.local_admission()?,
                    )
                }
                InputRequest::Close => self.background.close_input_for_actor_authorized(
                    scope,
                    action_id,
                    &operation_id,
                    &command,
                    &auth,
                    &self.authority,
                    self.local_admission()?,
                ),
            }
        })
        .await
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
        self.start_checked_tool(call_id, command, timeout, false)
            .await
    }
    async fn start_interactive(
        self: Arc<Self>,
        call_id: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> Result<(String, BackgroundSnapshot), String> {
        self.start_checked_tool(call_id, command, timeout, true)
            .await
    }
    async fn write_input(&self, call_id: &str, action_id: &str, text: &str) -> Result<(), String> {
        self.input_operation_checked(call_id, action_id, InputRequest::Write(text))
            .await
    }
    async fn close_input(&self, call_id: &str, action_id: &str) -> Result<(), String> {
        self.input_operation_checked(call_id, action_id, InputRequest::Close)
            .await
    }
    async fn write_bytes(
        &self,
        call_id: &str,
        action_id: &str,
        encoded: &str,
    ) -> Result<(), String> {
        let bytes = crate::v4_agent::background_process::tool::checked_binary_input(encoded)?;
        self.input_operation_checked(
            call_id,
            action_id,
            InputRequest::Binary {
                bytes: &bytes,
                encoded,
            },
        )
        .await
    }
    async fn status(&self, action_id: &str) -> Result<BackgroundSnapshot, String> {
        BackgroundTurn::status(self, action_id).await
    }
    async fn list(&self) -> Result<Vec<(String, BackgroundSnapshot)>, String> {
        BackgroundTurn::list(self).await
    }
    async fn wait(
        &self,
        action_id: &str,
        timeout: std::time::Duration,
    ) -> Result<BackgroundSnapshot, String> {
        BackgroundTurn::wait(self, action_id, timeout).await
    }
    async fn wait_output(
        &self,
        action_id: &str,
        after_revision: u64,
        timeout: std::time::Duration,
    ) -> Result<(BackgroundSnapshot, u64), String> {
        BackgroundTurn::wait_output(self, action_id, after_revision, timeout).await
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

    async fn follow_output(
        &self,
        call_id: &str,
        action_id: &str,
        after_revision: u64,
        timeout: std::time::Duration,
    ) -> Result<(BackgroundSnapshot, u64, Option<BackgroundSnapshot>), String> {
        self.follow_output_checked(call_id, action_id, after_revision, timeout)
            .await
    }
    async fn private_preview(
        &self,
        approval_id: &str,
        action_id: &str,
        context: &PairedDecisionContext,
    ) -> Result<(String, Value), String> {
        self.private_output_preview_with_context(approval_id, action_id, context)
            .await
    }
    async fn private_decision(
        &self,
        approval_id: &str,
        action_id: &str,
        token: &str,
        context: &PairedDecisionContext,
    ) -> Result<DecisionReceipt, String> {
        self.private_output_decision(approval_id, action_id, token, context)
            .await
    }
}
