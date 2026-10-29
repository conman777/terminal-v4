//! Approval preparation. It does not establish parent lifecycle
//! ownership or advertise a delegation tool.
use super::{
    delegation_outbox::{Binding, DelegationAuthorization, Permission},
    interaction::{self, ActionScope, ApprovalRequest, Cancellation, Interaction},
    Session,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    prompt: String,
}

// Detects replacement through approval and the final launch check. It does not
// make the subsequent pathname-based spawn atomic against directory replacement.
struct DirectoryScope {
    path: PathBuf,
    directory: File,
}

impl DirectoryScope {
    #[cfg(unix)]
    fn capture(path: &Path) -> Result<Self, String> {
        use std::os::unix::fs::OpenOptionsExt;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "Delegation directory unavailable")?;
        let scope = Self {
            path: path.to_owned(),
            directory,
        };
        scope.check()?;
        Ok(scope)
    }

    #[cfg(not(unix))]
    fn capture(_path: &Path) -> Result<Self, String> {
        Err("Delegation directory identity is unavailable on this platform".into())
    }

    #[cfg(unix)]
    fn check(&self) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let opened = self
            .directory
            .metadata()
            .map_err(|_| "Delegation directory unavailable")?;
        let current = std::fs::symlink_metadata(&self.path)
            .map_err(|_| "Delegation directory unavailable")?;
        if !opened.is_dir()
            || !current.is_dir()
            || current.file_type().is_symlink()
            || (opened.dev(), opened.ino()) != (current.dev(), current.ino())
            || self.path.canonicalize().ok().as_deref() != Some(self.path.as_path())
        {
            return Err("Delegation directory changed".into());
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn check(&self) -> Result<(), String> {
        Err("Delegation directory identity is unavailable on this platform".into())
    }
}

pub(super) struct ApprovedDelegation {
    binding: Binding,
    expires_at: i64,
    cancellation: Cancellation,
    workspace_scope: DirectoryScope,
    data_scope: DirectoryScope,
}
impl ApprovedDelegation {
    pub(super) fn binding(&self) -> &Binding {
        &self.binding
    }
    pub(super) fn check(&self) -> Result<(), String> {
        self.cancellation.check()?;
        self.check_expiry()?;
        self.check_directories()
    }
    pub(super) fn check_directories(&self) -> Result<(), String> {
        self.workspace_scope.check()?;
        self.data_scope.check()
    }
    pub(super) fn check_expiry(&self) -> Result<(), String> {
        if interaction::now_ms() >= self.expires_at {
            return Err("Delegation approval expired".into());
        }
        Ok(())
    }

    pub(super) fn admit_launch<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.cancellation.admit(|| {
            self.check_expiry()?;
            self.check_directories()?;
            action()
        })
    }
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

#[cfg(test)]
pub(super) async fn review(
    data: &Path,
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    queue_identity: Uuid,
    call_id: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancellation: &Cancellation,
) -> Result<ApprovedDelegation, String> {
    use sha2::{Digest, Sha256};
    let file = data
        .join("structured-sessions")
        .join(hex::encode(Sha256::digest(owner.as_bytes())))
        .join(format!("{}.json", scope.session_id));
    let incarnation = std::fs::read(file).ok().and_then(|bytes| {
        let first_line = bytes.split(|byte| *byte == b'\n').next()?;
        let value: Value = serde_json::from_slice(first_line).ok()?;
        Uuid::parse_str(value.get("sessionIncarnation")?.as_str()?).ok()
    });
    review_with_authorization(
        data,
        owner,
        session,
        scope,
        queue_identity,
        incarnation,
        None,
        call_id,
        input,
        interaction,
        cancellation,
    )
    .await
}

pub(super) async fn review_with_authorization(
    data: &Path,
    owner: &str,
    session: &Session,
    scope: &ActionScope,
    queue_identity: Uuid,
    parent_incarnation: Option<Uuid>,
    authorization: Option<DelegationAuthorization>,
    call_id: &str,
    input: &Value,
    interaction: &dyn Interaction,
    cancellation: &Cancellation,
) -> Result<ApprovedDelegation, String> {
    if scope.owner != owner
        || !valid_id(owner)
        || !valid_id(&scope.turn_id)
        || !valid_id(call_id)
        || crate::structured::engine_session_id(&scope.session_id)
            .ok()
            .as_deref()
            != Some(session.id.as_str())
        || !super::supports_tasks(&session.provider)
    {
        return Err("Delegation scope does not match this conversation".into());
    }
    let args: Arguments =
        serde_json::from_value(input.clone()).map_err(|_| "Invalid delegation arguments")?;
    if args.prompt.trim().is_empty()
        || args.prompt.chars().count() > 32_000
        || args.prompt.contains('\0')
    {
        return Err("Invalid delegation prompt".into());
    }
    let workspace = Path::new(&session.workspace)
        .canonicalize()
        .map_err(|_| "Workspace unavailable")?;
    if workspace != Path::new(&session.workspace) || !workspace.is_dir() {
        return Err("Workspace scope changed".into());
    }
    let data_root = data
        .canonicalize()
        .map_err(|_| "Data directory unavailable")?;
    let workspace_scope = DirectoryScope::capture(&workspace)?;
    let data_scope = DirectoryScope::capture(&data_root)?;
    let binding = Binding {
        owner: owner.into(),
        data_root: data_root.to_str().ok_or("Invalid data directory")?.into(),
        parent_session: scope.session_id.clone(),
        parent_turn: scope.turn_id.clone(),
        parent_incarnation,
        queue_identity,
        child_session: Uuid::new_v4().to_string(),
        task: Uuid::new_v4().to_string(),
        workspace: session.workspace.clone(),
        provider: session.provider.clone(),
        model: session.model.clone(),
        prompt: args.prompt,
        permission: Permission::ReadOnlyChild,
        operation_id: Uuid::new_v4(),
        authorization,
    };
    super::delegation_outbox::validate_binding(&binding)?;
    crate::workspace_tasks::validate_held_delegation(
        &binding.task_input(),
        Uuid::parse_str(&binding.task).map_err(|_| "Invalid delegation task ID")?,
    )
    .map_err(|error| error.message)?;
    let details = serde_json::to_value(&binding).map_err(|_| "Cannot encode delegation review")?;
    let delivery = if cfg!(feature = "queued-authority-preview") && binding.authorization.is_some()
    {
        "If the initiating authorization remains valid, a new empty follow-up queue is enabled automatically. Other held queues require resume."
    } else {
        "If delivery remains available, its result will enter the parent follow-up queue held for review. Otherwise, review the retained task result."
    };
    let expires_at = interaction::now_ms() + 300_000;
    let approved = cancellation.run(interaction.approve(ApprovalRequest {
        id: Uuid::new_v4().to_string(), scope: scope.clone(), tool_call_id: call_id.into(),
        tool_name: "delegate_task_background".into(), tool_input: details.clone(),
        description: format!("Run a read-only child investigation in the background. Shell, writes and external tools are unavailable. {delivery}\nExact scope and request:\n{}", serde_json::to_string_pretty(&details).map_err(|_| "Cannot encode delegation review")?),
        expires_at,
    })).await?;
    if !approved {
        return Err("Delegation was not approved".into());
    }
    let result = ApprovedDelegation {
        binding,
        expires_at,
        cancellation: cancellation.clone(),
        workspace_scope,
        data_scope,
    };
    result.check()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use terminal_v4_core::StructuredSessionEvent;

    struct Gate {
        approved: bool,
        requests: Mutex<Vec<ApprovalRequest>>,
    }

    #[test]
    fn launch_admission_rechecks_cancellation_and_expiry_before_action() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().canonicalize().unwrap();
        let mut approved = ApprovedDelegation {
            binding: Binding {
                owner: "owner".into(),
                data_root: "/tmp".into(),
                parent_session: "parent".into(),
                parent_turn: "turn".into(),
                parent_incarnation: None,
                queue_identity: Uuid::new_v4(),
                child_session: "child".into(),
                task: "task".into(),
                workspace: "/tmp".into(),
                provider: "deepseek".into(),
                model: "fixture".into(),
                prompt: "inspect".into(),
                permission: Permission::ReadOnlyChild,
                operation_id: Uuid::new_v4(),
                authorization: None,
            },
            expires_at: interaction::now_ms() + 10_000,
            cancellation: Cancellation::default(),
            workspace_scope: DirectoryScope::capture(&path).unwrap(),
            data_scope: DirectoryScope::capture(&path).unwrap(),
        };
        assert_eq!(approved.admit_launch(|| Ok("started")).unwrap(), "started");
        approved.expires_at = interaction::now_ms();
        assert!(approved
            .admit_launch(|| -> Result<(), String> { panic!("expired launch ran") })
            .is_err());
        approved.expires_at = interaction::now_ms() + 10_000;
        approved.cancellation.cancel();
        assert!(approved
            .admit_launch(|| -> Result<(), String> { panic!("cancelled launch ran") })
            .is_err());
    }
    #[async_trait]
    impl Interaction for Gate {
        async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
            self.requests.lock().unwrap().push(request);
            Ok(self.approved)
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approval_rejects_workspace_replaced_during_decision() {
        struct ReplaceWorkspace {
            original: PathBuf,
            moved: PathBuf,
        }
        #[async_trait]
        impl Interaction for ReplaceWorkspace {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalRequest) -> Result<bool, String> {
                std::fs::rename(&self.original, &self.moved).unwrap();
                std::fs::create_dir(&self.original).unwrap();
                Ok(true)
            }
        }
        let data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let moved = parent.path().canonicalize().unwrap().join("moved");
        let session = super::super::new_session("deepseek", "deepseek-chat", &workspace);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &ReplaceWorkspace {
                original: workspace.clone(),
                moved: moved.clone()
            },
            &Cancellation::default()
        )
        .await
        .is_err());
        std::fs::remove_dir(&workspace).unwrap();
        std::fs::rename(&moved, &workspace).unwrap();
    }

    #[tokio::test]
    async fn approval_describes_actual_automatic_or_held_delivery() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let incarnation = Uuid::new_v4();
        for has_local_authority in [false, true] {
            let gate = Gate {
                approved: true,
                requests: Mutex::new(Vec::new()),
            };
            let authorization = has_local_authority.then_some(DelegationAuthorization {
                session_incarnation: incarnation,
                generation: 0,
                expires_at_ms: interaction::now_ms() + 60_000,
            });
            review_with_authorization(
                data.path(),
                "owner",
                &session,
                &scope,
                Uuid::new_v4(),
                Some(incarnation),
                authorization,
                "call",
                &serde_json::json!({"prompt":"Inspect"}),
                &gate,
                &Cancellation::default(),
            )
            .await
            .unwrap();
            let requests = gate.requests.lock().unwrap();
            let description = &requests[0].description;
            if cfg!(feature = "queued-authority-preview") && has_local_authority {
                assert!(description.contains("automatically"), "{description}");
                assert!(
                    description.contains("authorization remains valid"),
                    "{description}"
                );
            } else {
                assert!(description.contains("held"), "{description}");
                assert!(
                    !description.contains("enabled automatically"),
                    "{description}"
                );
            }
        }
    }

    #[tokio::test]
    async fn approval_binds_exact_parent_scope_and_generated_child() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let gate = Gate {
            approved: true,
            requests: Mutex::new(Vec::new()),
        };
        let queue_identity = Uuid::new_v4();
        let approved = review(
            data.path(),
            "owner",
            &session,
            &scope,
            queue_identity,
            "call-1",
            &serde_json::json!({"prompt":"Inspect the code"}),
            &gate,
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let requests = gate.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].scope, scope);
        assert_eq!(requests[0].tool_call_id, "call-1");
        assert_eq!(requests[0].tool_name, "delegate_task_background");
        assert_eq!(
            requests[0].tool_input,
            serde_json::to_value(approved.binding()).unwrap()
        );
        assert_eq!(approved.binding().permission, Permission::ReadOnlyChild);
        assert_eq!(approved.binding().parent_session, scope.session_id);
        assert_eq!(approved.binding().parent_turn, scope.turn_id);
        assert_eq!(approved.binding().queue_identity, queue_identity);
        assert_eq!(approved.binding().provider, session.provider);
        assert_eq!(approved.binding().model, session.model);
        assert_eq!(approved.binding().workspace, session.workspace);
        assert_eq!(approved.binding().prompt, "Inspect the code");
        assert!(!Uuid::parse_str(&approved.binding().child_session)
            .unwrap()
            .is_nil());
        let binding = approved.binding().clone();
        drop(requests);
        let outbox = super::super::delegation_outbox::Outbox::create(
            &data.path().canonicalize().unwrap().join("outbox"),
        )
        .unwrap();
        let (task, command) = outbox
            .prepare_reviewed_held_child(data.path(), approved)
            .await
            .unwrap();
        assert_eq!(task.id.to_string(), binding.task);
        assert_eq!(
            task.status,
            crate::workspace_tasks::TaskStatus::DelegationHeld
        );
        assert_eq!(
            outbox
                .read("owner", binding.operation_id)
                .unwrap()
                .unwrap()
                .binding,
            binding
        );
        assert!(command
            .as_std()
            .get_args()
            .any(|arg| arg == binding.child_session.as_str()));
    }

    #[tokio::test]
    async fn cancelled_after_review_does_not_admit_the_child() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let gate = Gate {
            approved: true,
            requests: Mutex::new(Vec::new()),
        };
        let cancellation = Cancellation::default();
        let approved = review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &cancellation,
        )
        .await
        .unwrap();
        let operation = approved.binding().operation_id;
        cancellation.cancel();
        let outbox = super::super::delegation_outbox::Outbox::create(
            &data.path().canonicalize().unwrap().join("outbox"),
        )
        .unwrap();
        assert!(outbox
            .prepare_reviewed_held_child(data.path(), approved)
            .await
            .is_err());
        assert!(outbox.read("owner", operation).unwrap().is_none());
        assert!(!data.path().join("workspace-tasks").exists());
    }

    #[tokio::test]
    async fn denied_cancelled_foreign_and_forged_requests_never_authorize() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.path().canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let denied = Gate {
            approved: false,
            requests: Mutex::new(Vec::new()),
        };
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &denied,
            &Cancellation::default()
        )
        .await
        .is_err());
        let gate = Gate {
            approved: true,
            requests: Mutex::new(Vec::new()),
        };
        let cancel = Cancellation::default();
        cancel.cancel();
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &cancel
        )
        .await
        .is_err());
        let mut foreign = scope.clone();
        foreign.owner = "other".into();
        assert!(review(
            data.path(),
            "owner",
            &session,
            &foreign,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect", "provider":"codex"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(gate.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_persisted_task_fields_are_rejected_before_approval() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.path().canonicalize().unwrap(),
        );
        let session_id = Uuid::parse_str(&session.id).unwrap();
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", session_id.simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let gate = Gate {
            approved: true,
            requests: Mutex::new(Vec::new()),
        };
        session.model = " ".into();
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        session.model = "m".repeat(201);
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        session.model = "fixture-model".into();
        let mut legacy_scope = scope.clone();
        legacy_scope.session_id = format!("ss-{session_id}");
        assert!(review(
            data.path(),
            "owner",
            &session,
            &legacy_scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(gate.requests.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unrepresentable_workspace_is_rejected_before_approval() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("project\nname");
        std::fs::create_dir(&workspace).unwrap();
        let session = super::super::new_session(
            "deepseek",
            "fixture-model",
            &workspace.canonicalize().unwrap(),
        );
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: format!("ss-{}", Uuid::parse_str(&session.id).unwrap().simple()),
            turn_id: Uuid::new_v4().to_string(),
        };
        let gate = Gate {
            approved: true,
            requests: Mutex::new(Vec::new()),
        };
        assert!(review(
            data.path(),
            "owner",
            &session,
            &scope,
            Uuid::new_v4(),
            "call",
            &serde_json::json!({"prompt":"Inspect"}),
            &gate,
            &Cancellation::default()
        )
        .await
        .is_err());
        assert!(gate.requests.lock().unwrap().is_empty());
    }
}
