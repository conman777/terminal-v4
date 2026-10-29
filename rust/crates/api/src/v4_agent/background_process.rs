//! Durable, scoped claims and process-local execution. The caller must authenticate
//! the scope and obtain exact per-action approval before `start`. No command or
//! output is persisted. Unfinished claims remain unknown after a crash; no replay
//! or PID-based recovery is attempted. Reopening an unfinished or invalid
//! receipt blocks new actions until recovery is confirmed; no recovery override
//! is implemented. Creation must only be used for an explicitly provisioned new
//! ledger; reopening never creates missing state.
//! Await shutdown before stopping the runtime.
//! Unix ancestry tracking cannot guarantee containment of an unobserved escape.
#[path = "background_bootstrap.rs"]
pub(crate) mod bootstrap;
#[path = "background_process_ledger.rs"]
mod ledger;
#[cfg(unix)]
pub(crate) use super::background_owner_gate as owner_gate;
#[path = "background_tool.rs"]
#[cfg(test)]
pub(crate) mod tool;
#[cfg(unix)]
#[path = "background_process_watchdog.rs"]
mod watchdog;
use ledger::Ledger;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Mutex as AsyncMutex},
};

pub(super) const OUTPUT_LIMIT: usize = 64 * 1024;
const MAX_ACTIONS: usize = 128;
/// Durable receipts are retained for replay protection until their session is
/// deleted, so each owner and session is capped to stop one from consuming
/// the global receipt budget.
pub(super) const MAX_OWNER_ACTIONS: usize = 64;
pub(super) const MAX_SESSION_ACTIONS: usize = 32;
/// Live process slots are derived from tracked entries that have not finished,
/// so a slot is released as soon as its worker commits a terminal outcome.
const MAX_RUNNING_PER_OWNER: usize = 8;
const MAX_RUNNING_TOTAL: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackgroundScope {
    pub owner: String,
    pub session: String,
    pub workspace: PathBuf,
    pub incarnation: Option<uuid::Uuid>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackgroundRequest {
    pub scope: BackgroundScope,
    // Must be captured from the admitted credential, not sampled after authentication.
    pub authorization_generation: Option<i64>,
    pub action_id: String,
    pub command: String,
    pub timeout: Duration,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BackgroundState {
    Running,
    Exited { code: Option<i32> },
    Cancelled,
    TimedOut,
    CleanupUnconfirmed,
    FailedToStart,
    Unknown,
}
#[derive(Clone, Debug)]
pub(crate) struct BackgroundSnapshot {
    pub state: BackgroundState,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub output_withheld: bool,
}
#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    truncated: bool,
    failed: bool,
}
impl Output {
    fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if text.len() > OUTPUT_LIMIT {
            let mut end = OUTPUT_LIMIT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        text
    }
}
struct Entry {
    scope: BackgroundScope,
    state: Mutex<BackgroundState>,
    stdout: Mutex<Output>,
    stderr: Mutex<Output>,
    cancel: watch::Sender<bool>,
    done: watch::Sender<bool>,
}
#[derive(Default)]
struct Registry {
    closed: bool,
    entries: HashMap<Vec<u8>, Arc<Entry>>,
    closed_sessions: HashSet<(String, String)>,
    shutdown_failed: bool,
    workers: Vec<tokio::task::JoinHandle<()>>,
}
pub(crate) struct BackgroundProcesses {
    #[cfg(unix)]
    instance_id: uuid::Uuid,
    #[cfg(all(test, unix))]
    coordinator_lifecycle: std::sync::RwLock<bool>,
    registry: AsyncMutex<Registry>,
    #[cfg(all(test, unix))]
    claim_pause: Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            std::sync::mpsc::Receiver<()>,
        )>,
    >,
    ledger: Arc<Ledger>,
    recovery_blocked: std::sync::atomic::AtomicBool,
    unconfirmed: Arc<Mutex<bool>>,
    running_limits: (
        std::sync::atomic::AtomicUsize,
        std::sync::atomic::AtomicUsize,
    ),
    #[cfg(unix)]
    owner_gate: Option<Arc<owner_gate::OwnerGate>>,
}

#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct OwnerCleanupReceipt {
    owner: String,
    request: String,
    instance_id: uuid::Uuid,
}

#[cfg(all(test, unix))]
pub(crate) struct OwnerCleanupReleaseGuard<'a> {
    _lifecycle: std::sync::RwLockReadGuard<'a, bool>,
}

impl BackgroundProcesses {
    #[cfg(all(test, unix))]
    pub(crate) fn validate_actor_binding(&self, root: &std::path::Path) -> Result<(), String> {
        self.owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?
            .validate_actor_root(root)?;
        self.ledger.validate_actor_root(root)
    }

    /// The caller must execute this on a blocking worker. The durable owner
    /// hold fences launches while the user-reviewed receipts are committed.
    #[cfg(unix)]
    pub(crate) fn review_unknown_owner_authorized(
        &self,
        app: &crate::state::AppState,
        owner: &str,
        authority: &crate::auth::LocalAuthority,
        request: &str,
        operation: uuid::Uuid,
        acknowledged: bool,
    ) -> Result<usize, String> {
        if !acknowledged {
            return Err("Explicit background process acknowledgment is required".into());
        }
        let registry = self.registry.blocking_lock();
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.scope.owner == owner)
        {
            if !*entry.done.borrow()
                || matches!(
                    *entry
                        .state
                        .lock()
                        .map_err(|_| "Background cleanup is unconfirmed")?,
                    BackgroundState::Running
                        | BackgroundState::CleanupUnconfirmed
                        | BackgroundState::Unknown
                )
            {
                return Err("Tracked background process cleanup is unconfirmed".into());
            }
        }
        let gate = self
            .owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?;
        let binding = self
            .ledger
            .installation_binding()?
            .ok_or("Background ledger identity is unavailable")?;
        let result = app.with_owner_review(owner, authority, |tx, auth_check| {
            let check = || {
                auth_check()?;
                gate.validate_review_transaction(tx, owner, request)?;
                if self.ledger.installation_binding()?.as_deref() != Some(binding.as_slice()) {
                    return Err("Background ledger identity changed".into());
                }
                Ok(())
            };
            check()?;
            let count = self.ledger.review_unknown_owner(owner, request, operation, check)?;
            tx.execute("INSERT INTO structured_owner_background_reviews(owner,request,operation,count,ledger_binding) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner,operation) DO NOTHING", rusqlite::params![owner,request,operation.to_string(),count as i64,binding]).map_err(|_| "Cannot persist background review audit")?;
            let matches: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_background_reviews WHERE owner=?1 AND request=?2 AND operation=?3 AND count=?4 AND ledger_binding=?5)", rusqlite::params![owner,request,operation.to_string(),count as i64,binding], |row| row.get(0)).map_err(|_| "Cannot inspect background review audit")?;
            if !matches { return Err("Background review audit identity changed".into()); }
            Ok(count)
        });
        if result.is_ok() && !self.ledger.has_unknown(None)? {
            self.recovery_blocked
                .store(false, std::sync::atomic::Ordering::Release);
        }
        result
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn review_unknown_owner(
        &self,
        owner: &str,
        request: &str,
        operation: uuid::Uuid,
        acknowledged: bool,
    ) -> Result<usize, String> {
        if !acknowledged {
            return Err("Explicit background process acknowledgment is required".into());
        }
        let registry = self.registry.lock().await;
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.scope.owner == owner)
        {
            if !*entry.done.borrow()
                || matches!(
                    *entry
                        .state
                        .lock()
                        .map_err(|_| "Background cleanup is unconfirmed")?,
                    BackgroundState::Running
                        | BackgroundState::CleanupUnconfirmed
                        | BackgroundState::Unknown
                )
            {
                return Err("Tracked background process cleanup is unconfirmed".into());
            }
        }
        self.owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?
            .with_review_hold(owner, request, |check| {
                self.ledger
                    .review_unknown_owner(owner, request, operation, check)
            })
    }

    #[cfg(all(test, unix))]
    pub(crate) fn release_owner_hold_in_transaction<'a>(
        &'a self,
        receipt: &OwnerCleanupReceipt,
        owner: &str,
        request: &str,
        tx: &rusqlite::Transaction<'_>,
    ) -> Result<OwnerCleanupReleaseGuard<'a>, String> {
        let lifecycle = self
            .coordinator_lifecycle
            .try_read()
            .map_err(|_| "Background manager lifecycle is unavailable")?;
        if !*lifecycle
            || receipt.instance_id != self.instance_id
            || receipt.owner != owner
            || receipt.request != request
        {
            return Err("Background owner cleanup receipt is stale or mismatched".into());
        }
        if *self
            .unconfirmed
            .lock()
            .map_err(|_| "Background cleanup is unconfirmed")?
            || self.ledger.has_unknown_owner(owner)?
        {
            return Err("Background owner cleanup is unconfirmed".into());
        }
        self.owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?
            .release_in_transaction(tx, owner, request)?;
        Ok(OwnerCleanupReleaseGuard {
            _lifecycle: lifecycle,
        })
    }
    pub(super) fn ensure_authorized(
        &self,
        scope: &BackgroundScope,
        generation: Option<i64>,
    ) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(gate) = &self.owner_gate {
            let generation = generation.ok_or("Background authorization is unavailable")?;
            let (_, confirmed) = gate.admit_generation(&scope.owner, generation, || Ok(()))?;
            if !confirmed {
                return Err("Background authorization could not be confirmed".into());
            }
        }
        #[cfg(not(unix))]
        let _ = (scope, generation);
        Ok(())
    }
    #[cfg(unix)]
    pub(crate) fn create_controlled(
        path: &std::path::Path,
        gate: Arc<owner_gate::OwnerGate>,
    ) -> Result<Self, String> {
        let mut manager = Self::create(path)?;
        manager.owner_gate = Some(gate);
        Ok(manager)
    }
    #[cfg(unix)]
    pub(crate) fn open_controlled(
        path: &std::path::Path,
        gate: Arc<owner_gate::OwnerGate>,
    ) -> Result<Self, String> {
        let mut manager = Self::open(path)?;
        manager.owner_gate = Some(gate);
        Ok(manager)
    }
    #[cfg(unix)]
    pub(crate) fn owner_cleanup_unconfirmed(&self, owner: &str) -> Result<bool, String> {
        if owner.trim().is_empty() || owner.len() > 256 || owner.chars().any(char::is_control) {
            return Err("Invalid background owner".into());
        }
        self.ledger.has_unknown_owner(owner)
    }

    #[cfg(unix)]
    pub(crate) async fn service_owner_holds(&self) -> Result<usize, String> {
        use futures_util::{stream, StreamExt};

        let gate = self
            .owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?;
        let mut completed = 0;
        let mut failure = None;
        let mut pending = stream::iter(gate.pending()?.into_iter().map(
            |(owner, request)| async move { self.service_owner_hold(gate, &owner, &request).await },
        ))
        .buffer_unordered(16);
        while let Some(result) = pending.next().await {
            match result {
                Ok(true) => completed += 1,
                Ok(false) => {}
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(completed),
        }
    }

    /// Confirms only background-process cleanup. The caller must also finish
    /// every other owner cleanup before releasing the returned hold.
    #[cfg(unix)]
    pub(crate) async fn confirm_owner_hold(
        &self,
        owner: &str,
        request: &str,
    ) -> Result<OwnerCleanupReceipt, String> {
        let gate = self
            .owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?;
        if gate.status(owner, request)? == "held" {
            self.service_owner_hold(gate, owner, request).await?;
        }
        let registry = self.registry.lock().await;
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.scope.owner == owner)
        {
            let done = *entry.done.borrow();
            let state = entry
                .state
                .lock()
                .map_err(|_| "Background owner cleanup is unconfirmed")?;
            if !done
                || matches!(
                    *state,
                    BackgroundState::Running
                        | BackgroundState::CleanupUnconfirmed
                        | BackgroundState::Unknown
                )
            {
                return Err("Background owner cleanup is unconfirmed".into());
            }
        }
        if self.ledger.has_unknown_owner(owner)? || gate.status(owner, request)? != "acknowledged" {
            return Err("Background owner cleanup is unconfirmed".into());
        }
        Ok(OwnerCleanupReceipt {
            owner: owner.into(),
            request: request.into(),
            instance_id: self.instance_id,
        })
    }

    /// Call only after the coordinator confirms structured sessions, delegated
    /// children and any other required owner resources are also stopped.
    #[cfg(unix)]
    pub(crate) fn release_owner_hold(&self, receipt: OwnerCleanupReceipt) -> Result<(), String> {
        if receipt.instance_id != self.instance_id {
            return Err("Background owner cleanup receipt belongs to another manager".into());
        }
        self.owner_gate
            .as_ref()
            .ok_or("Background owner control is unavailable")?
            .release(&receipt.owner, &receipt.request)
    }
    #[cfg(unix)]
    async fn service_owner_hold(
        &self,
        gate: &owner_gate::OwnerGate,
        owner: &str,
        request: &str,
    ) -> Result<bool, String> {
        let entries: Vec<_> = {
            let registry = self.registry.lock().await;
            if gate.status(owner, request)? != "held" {
                return Ok(false);
            }
            let entries = registry
                .entries
                .values()
                .filter(|entry| entry.scope.owner == owner)
                .cloned()
                .collect::<Vec<_>>();
            for entry in &entries {
                let _ = entry.cancel.send(true);
            }
            entries
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            for entry in entries {
                let mut done = entry.done.subscribe();
                while !*done.borrow_and_update() {
                    done.changed()
                        .await
                        .map_err(|_| "Background owner cleanup is unconfirmed")?;
                }
                if matches!(
                    *entry.state.lock().unwrap(),
                    BackgroundState::CleanupUnconfirmed | BackgroundState::Unknown
                ) {
                    return Err("Background owner cleanup is unconfirmed");
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| "Background owner cleanup is unconfirmed")??;
        if self.ledger.has_unknown_owner(owner)? {
            return Err("Background owner cleanup is unconfirmed".into());
        }
        match self.ledger.installation_binding()? {
            Some(binding) => gate.acknowledge_quiescence(owner, request, &binding)?,
            None => gate.acknowledge(owner, request)?,
        }
        Ok(true)
    }
    #[cfg(unix)]
    pub(crate) async fn monitor_owner_holds(
        &self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if self.owner_gate.is_none() {
            return Err("Background owner control is unavailable".into());
        }
        let mut interval = tokio::time::interval(Duration::from_millis(200));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_error: Option<String> = None;
        loop {
            if *shutdown.borrow_and_update() {
                return Ok(());
            }
            tokio::select! {
                changed = shutdown.changed() => match changed {
                    Err(_) => return Err("Background owner monitor shutdown control was lost".into()),
                    Ok(()) if *shutdown.borrow_and_update() => return Ok(()),
                    Ok(()) => {},
                },
                _ = interval.tick() => {
                    tokio::select! {
                        result = self.service_owner_holds() => match result {
                            Ok(_) => last_error = None,
                            Err(error) => {
                                if last_error.as_deref() != Some(error.as_str()) { tracing::warn!(%error, "Background owner cleanup remains unconfirmed"); }
                                last_error = Some(error);
                            },
                        },
                        changed = shutdown.changed() => match changed {
                            Err(_) => return Err("Background owner monitor shutdown control was lost".into()),
                            Ok(()) if *shutdown.borrow_and_update() => return Ok(()),
                            Ok(()) => {},
                        },
                    }
                },
            }
        }
    }
    fn finish_unstarted_claim(&self, key: &[u8]) -> Result<(), String> {
        let mut unconfirmed = self
            .unconfirmed
            .lock()
            .map_err(|_| "Background recovery is unconfirmed")?;
        match self.ledger.finish(key, &BackgroundState::FailedToStart) {
            Ok(()) => Ok(()),
            Err(error) => {
                *unconfirmed = true;
                Err(error)
            }
        }
    }

    pub(crate) fn create(path: &std::path::Path) -> Result<Self, String> {
        Ok(Self {
            #[cfg(unix)]
            instance_id: uuid::Uuid::new_v4(),
            #[cfg(all(test, unix))]
            coordinator_lifecycle: std::sync::RwLock::new(true),
            registry: AsyncMutex::new(Registry::default()),
            #[cfg(all(test, unix))]
            claim_pause: Mutex::new(None),
            ledger: Arc::new(Ledger::create(path)?),
            recovery_blocked: std::sync::atomic::AtomicBool::new(false),
            unconfirmed: Arc::new(Mutex::new(false)),
            running_limits: Self::default_running_limits(),
            #[cfg(unix)]
            owner_gate: None,
        })
    }

    fn default_running_limits() -> (
        std::sync::atomic::AtomicUsize,
        std::sync::atomic::AtomicUsize,
    ) {
        (
            std::sync::atomic::AtomicUsize::new(MAX_RUNNING_PER_OWNER),
            std::sync::atomic::AtomicUsize::new(MAX_RUNNING_TOTAL),
        )
    }

    #[cfg(test)]
    pub(crate) fn set_running_limits_for_test(&self, per_owner: usize, total: usize) {
        use std::sync::atomic::Ordering::SeqCst;
        self.running_limits.0.store(per_owner, SeqCst);
        self.running_limits.1.store(total, SeqCst);
    }

    pub(crate) fn open(path: &std::path::Path) -> Result<Self, String> {
        let ledger = Arc::new(Ledger::open(path)?);
        let recovery_blocked = ledger.has_unknown(None)?;
        Ok(Self {
            #[cfg(unix)]
            instance_id: uuid::Uuid::new_v4(),
            #[cfg(all(test, unix))]
            coordinator_lifecycle: std::sync::RwLock::new(true),
            registry: AsyncMutex::new(Registry::default()),
            #[cfg(all(test, unix))]
            claim_pause: Mutex::new(None),
            ledger,
            recovery_blocked: std::sync::atomic::AtomicBool::new(recovery_blocked),
            unconfirmed: Arc::new(Mutex::new(false)),
            running_limits: Self::default_running_limits(),
            #[cfg(unix)]
            owner_gate: None,
        })
    }
    fn check_running_slots(&self, registry: &Registry, owner: &str) -> Result<(), String> {
        use std::sync::atomic::Ordering::SeqCst;
        let (mut owner_running, mut total_running) = (0, 0);
        for entry in registry.entries.values().filter(|e| !*e.done.borrow()) {
            total_running += 1;
            owner_running += usize::from(entry.scope.owner == owner);
        }
        if owner_running >= self.running_limits.0.load(SeqCst)
            || total_running >= self.running_limits.1.load(SeqCst)
        {
            return Err(
                "Too many background commands are running; cancel one or wait for it to finish"
                    .into(),
            );
        }
        Ok(())
    }
    /// Advisory preflight so a user is not asked to approve a command that
    /// admission would refuse; `start_with` rechecks under the registry lock.
    #[cfg(all(test, unix))]
    pub(crate) async fn ensure_capacity(&self, scope: &BackgroundScope) -> Result<(), String> {
        let registry = self.registry.lock().await;
        self.check_running_slots(&registry, &scope.owner)
    }
    // This preflight avoids requesting approval for a session already closed;
    // start_checked must recheck after approval because deletion can race it.
    pub(crate) async fn ensure_session_open(&self, scope: &BackgroundScope) -> Result<(), String> {
        if self
            .recovery_blocked
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Background recovery is unconfirmed; new actions are unavailable".into());
        }
        if *self
            .unconfirmed
            .lock()
            .map_err(|_| "Background recovery is unconfirmed")?
        {
            return Err("Background recovery is unconfirmed; new actions are unavailable".into());
        }
        if scope.owner.is_empty()
            || scope.session.is_empty()
            || scope.owner.len() > 256
            || scope.session.len() > 256
        {
            return Err("Invalid background session".into());
        }
        #[cfg(unix)]
        if let Some(gate) = &self.owner_gate {
            gate.ensure_open(&scope.owner)?;
        }
        let registry = self.registry.lock().await;
        if registry.closed {
            return Err("Background process manager is shut down".into());
        }
        if registry
            .closed_sessions
            .contains(&(scope.owner.clone(), scope.session.clone()))
            || self.ledger.is_retired(&scope.owner, &scope.session)?
        {
            return Err("Background session is closed".into());
        }
        Ok(())
    }
    // `approved` must be the immutable request recorded by the trusted approval
    // authority, not reconstructed from untrusted input or an approval boolean.
    #[cfg(test)]
    pub(super) async fn start(
        &self,
        request: BackgroundRequest,
        approved: Option<&BackgroundRequest>,
    ) -> Result<BackgroundSnapshot, String> {
        self.start_checked(
            request,
            approved,
            &super::interaction::Cancellation::default(),
            i64::MAX,
        )
        .await
    }
    pub(super) async fn start_checked(
        &self,
        request: BackgroundRequest,
        approved: Option<&BackgroundRequest>,
        cancellation: &super::interaction::Cancellation,
        expires_at: i64,
    ) -> Result<BackgroundSnapshot, String> {
        self.start_with(
            request,
            approved,
            cancellation,
            expires_at,
            false,
            |command| {
                command
                    .spawn()
                    .map_err(|_| "Cannot start background process".into())
            },
        )
        .await
    }

    #[cfg(all(test, unix))]
    pub(crate) fn pause_after_claim_for_test(
        &self,
        entered: tokio::sync::oneshot::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        *self.claim_pause.lock().unwrap() = Some((entered, release));
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn start_for_actor<F>(
        &self,
        request: BackgroundRequest,
        approved: &BackgroundRequest,
        cancellation: &super::interaction::Cancellation,
        expires_at: i64,
        launch: F,
    ) -> Result<BackgroundSnapshot, String>
    where
        F: FnOnce(&mut tokio::process::Command) -> Result<tokio::process::Child, String> + Send,
    {
        self.start_with(
            request,
            Some(approved),
            cancellation,
            expires_at,
            true,
            launch,
        )
        .await
    }

    async fn start_with<F>(
        &self,
        request: BackgroundRequest,
        approved: Option<&BackgroundRequest>,
        cancellation: &super::interaction::Cancellation,
        expires_at: i64,
        fail_fast: bool,
        launch: F,
    ) -> Result<BackgroundSnapshot, String>
    where
        F: FnOnce(&mut tokio::process::Command) -> Result<tokio::process::Child, String> + Send,
    {
        if approved != Some(&request) {
            return Err("Exact action approval required".into());
        }
        if self
            .recovery_blocked
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Background recovery is unconfirmed; new actions are unavailable".into());
        }
        if request.action_id.is_empty()
            || request.action_id.len() > 128
            || request.scope.owner.is_empty()
            || request.scope.session.is_empty()
            || request.scope.owner.len() > 256
            || request.scope.session.len() > 256
            || request.command.is_empty()
            || request.command.len() > 10_000
            || request.command.contains('\0')
            || request.timeout.is_zero()
            || request.timeout > Duration::from_secs(86400)
            || !request.scope.workspace.is_absolute()
            || std::fs::canonicalize(&request.scope.workspace)
                .ok()
                .as_ref()
                != Some(&request.scope.workspace)
            || !request.scope.workspace.is_dir()
        {
            return Err("Invalid background action".into());
        }
        let mut registry = if fail_fast {
            self.registry
                .try_lock()
                .map_err(|_| "Background admission is busy; retry")?
        } else {
            self.registry.lock().await
        };
        if registry.closed {
            return Err("Background process manager is shut down".into());
        }
        if registry
            .closed_sessions
            .contains(&(request.scope.owner.clone(), request.scope.session.clone()))
        {
            return Err("Background session is closed".into());
        }
        self.check_running_slots(&registry, &request.scope.owner)?;
        // Revalidate after waiting for admission; the workspace may have changed.
        if std::fs::canonicalize(&request.scope.workspace)
            .ok()
            .as_ref()
            != Some(&request.scope.workspace)
            || !request.scope.workspace.is_dir()
        {
            return Err("Background workspace changed before launch".into());
        }
        // Reject expired or cancelled requests before creating a durable claim.
        cancellation.check()?;
        if expires_at <= super::interaction::now_ms() {
            return Err("Approval expired".into());
        }
        self.ensure_authorized(&request.scope, request.authorization_generation)?;
        // The claim is committed before any process can start. Ambiguous failures
        // retain the claim instead of allowing a potentially duplicate execution.
        let key = self.ledger.claim(&request.scope, &request.action_id)?;
        #[cfg(all(test, unix))]
        if let Some((entered, release)) = self.claim_pause.lock().unwrap().take() {
            let _ = entered.send(());
            if release
                .recv_timeout(std::time::Duration::from_secs(10))
                .is_err()
            {
                self.finish_unstarted_claim(&key)?;
                return Err("Background claim test barrier timed out".into());
            }
        }
        #[cfg(unix)]
        let (mut command, status) = match watchdog::prepare(&request.command) {
            Ok(prepared) => prepared,
            Err(_) => {
                self.finish_unstarted_claim(&key)?;
                return Err("Cannot prepare background process".into());
            }
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", &request.command]);
            command.stdin(Stdio::null());
            command
        };
        command
            .current_dir(&request.scope.workspace)
            .env_clear()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "TERM",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        // The claim and command preparation can take time. This is the launch
        // admission point; an abandoned claim is never replayed.
        let launch = {
            // Serialize spawn with receipt persistence, but do not hold the
            // cancellation gate while waiting for a slow receipt.
            match self.unconfirmed.lock() {
                Ok(unconfirmed) if !*unconfirmed => {
                    let mut launch = Some(launch);
                    let mut run = || {
                        cancellation.admit(|| {
                            if expires_at <= super::interaction::now_ms() {
                                return Err("Background action expired before launch".into());
                            }
                            launch.take().ok_or("Background launch already consumed")?(&mut command)
                        })
                    };
                    #[cfg(unix)]
                    {
                        if let Some(gate) = &self.owner_gate {
                            match request.authorization_generation {
                                Some(generation) => {
                                    gate.admit_generation(&request.scope.owner, generation, run)
                                }
                                None => Err("Background authorization is unavailable".into()),
                            }
                        } else {
                            run().map(|child| (child, true))
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        run().map(|child| (child, true))
                    }
                }
                _ => Err("Background recovery is unconfirmed; new actions are unavailable".into()),
            }
        };
        let (mut child, admission_confirmed) = match launch {
            Ok(result) => result,
            Err(error) => {
                self.finish_unstarted_claim(&key)?;
                return Err(error);
            }
        };
        #[cfg(unix)]
        let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child);
        #[cfg(windows)]
        let tree = crate::process_tree::ProcessTree::attach(&child);
        let tree = match tree {
            Ok(tree) => tree,
            Err(_) => {
                registry.shutdown_failed = true;
                if let Ok(mut unconfirmed) = self.unconfirmed.lock() {
                    *unconfirmed = true;
                }
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                return Err("Cannot contain background process; cleanup is unconfirmed".into());
            }
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (cancel, cancel_rx) = watch::channel(false);
        let (done, _) = watch::channel(false);
        let entry = Arc::new(Entry {
            scope: request.scope,
            state: Mutex::new(BackgroundState::Running),
            stdout: Mutex::new(Output::default()),
            stderr: Mutex::new(Output::default()),
            cancel,
            done,
        });
        if !admission_confirmed {
            if let Ok(mut unconfirmed) = self.unconfirmed.lock() {
                *unconfirmed = true;
            }
            entry.cancel.send_replace(true);
        }
        let worker_entry = entry.clone();
        let worker_ledger = self.ledger.clone();
        let worker_key = key.clone();
        let worker_unconfirmed = self.unconfirmed.clone();
        let worker = tokio::spawn(async move {
            let process_entry = worker_entry.clone();
            let state = match tokio::spawn(run(
                process_entry,
                child,
                tree,
                stdout,
                stderr,
                #[cfg(unix)]
                status,
                cancel_rx,
                request.timeout,
            ))
            .await
            {
                Ok(state) => state,
                Err(_) => BackgroundState::CleanupUnconfirmed,
            };
            let state = match worker_unconfirmed.lock() {
                Ok(mut unconfirmed) => {
                    if matches!(
                        &state,
                        BackgroundState::CleanupUnconfirmed | BackgroundState::Unknown
                    ) {
                        *unconfirmed = true;
                    }
                    if worker_ledger.finish(&worker_key, &state).is_ok() {
                        state
                    } else {
                        *unconfirmed = true;
                        BackgroundState::Unknown
                    }
                }
                Err(_) => BackgroundState::Unknown,
            };
            *worker_entry.state.lock().unwrap() = state;
            worker_entry.done.send_replace(true);
        });
        registry.entries.insert(key, entry);
        registry.workers.push(worker);
        if !admission_confirmed {
            return Err(
                "Background action started but admission is unconfirmed; cleanup is in progress"
                    .into(),
            );
        }
        Ok(BackgroundSnapshot {
            state: BackgroundState::Running,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            output_withheld: false,
        })
    }
    async fn entry(&self, scope: &BackgroundScope, action_id: &str) -> Result<Arc<Entry>, String> {
        self.registry
            .lock()
            .await
            .entries
            .get(&Ledger::key(scope, action_id)?)
            .filter(|entry| &entry.scope == scope)
            .cloned()
            .ok_or_else(|| "Background action not found".into())
    }
    pub(super) async fn snapshot(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        let entry = match self.entry(scope, action_id).await {
            Ok(entry) => entry,
            Err(_) => {
                return Ok(BackgroundSnapshot {
                    state: self.ledger.read(scope, action_id)?,
                    stdout: String::new(),
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                    output_withheld: true,
                })
            }
        };
        let state = entry.state.lock().unwrap().clone();
        let stdout = entry.stdout.lock().unwrap();
        let stderr = entry.stderr.lock().unwrap();
        Ok(BackgroundSnapshot {
            state,
            // Arbitrary process output can contain credentials. No generic
            // redactor can safely release it to a model or persist it.
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: stdout.truncated
                || stdout.text().len() < String::from_utf8_lossy(&stdout.bytes).len(),
            stderr_truncated: stderr.truncated
                || stderr.text().len() < String::from_utf8_lossy(&stderr.bytes).len(),
            output_withheld: !stdout.bytes.is_empty() || !stderr.bytes.is_empty(),
        })
    }

    #[cfg(all(test, unix))]
    pub(crate) fn access_for_actor(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        generation: i64,
        expires_at: i64,
        cancellation: &super::interaction::Cancellation,
        cancel: bool,
    ) -> Result<BackgroundSnapshot, String> {
        if scope.incarnation.is_none() {
            return Err("Background session identity is required".into());
        }
        let registry = self
            .registry
            .try_lock()
            .map_err(|_| "Background registry busy; retry")?;
        if registry.closed
            || registry
                .closed_sessions
                .contains(&(scope.owner.clone(), scope.session.clone()))
        {
            return Err("Background session is closed".into());
        }
        let key = Ledger::key(scope, action_id)?;
        let entry = registry
            .entries
            .get(&key)
            .filter(|entry| entry.scope == *scope)
            .cloned();
        let gate = self
            .owner_gate
            .as_ref()
            .ok_or("Background owner control unavailable")?;
        let (snapshot, confirmed) = gate.admit_generation(&scope.owner, generation, || {
            cancellation.admit(|| {
                if super::interaction::now_ms() >= expires_at {
                    return Err("Background authorization expired".into());
                }
                if let Some(entry) = entry {
                    let state = entry.state.lock().map_err(|_| "Background state unavailable")?.clone();
                    let stdout = entry.stdout.lock().map_err(|_| "Background output unavailable")?;
                    let stderr = entry.stderr.lock().map_err(|_| "Background output unavailable")?;
                    if cancel { let _ = entry.cancel.send(true); }
                    Ok(BackgroundSnapshot {
                        state, stdout: String::new(), stderr: String::new(),
                        stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated,
                        output_withheld: !stdout.bytes.is_empty() || !stderr.bytes.is_empty(),
                    })
                } else {
                    let state = self.ledger.read(scope, action_id)?;
                    if cancel && matches!(state, BackgroundState::Running | BackgroundState::Unknown | BackgroundState::CleanupUnconfirmed) {
                        return Err("Background action ownership is unknown; cancellation cannot be confirmed".into());
                    }
                    Ok(BackgroundSnapshot { state, stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false, output_withheld: true })
                }
            })
        })?;
        if !confirmed {
            return Err("Background action outcome is uncertain".into());
        }
        Ok(snapshot)
    }

    /// Reads the bounded in-memory output under the same owner, credential,
    /// session-incarnation and cancellation fences as status. The caller must
    /// obtain explicit user approval of this exact snapshot before releasing it.
    #[cfg(all(test, unix))]
    pub(crate) fn output_for_actor(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        generation: i64,
        expires_at: i64,
        cancellation: &super::interaction::Cancellation,
    ) -> Result<BackgroundSnapshot, String> {
        if scope.incarnation.is_none() {
            return Err("Background session identity is required".into());
        }
        let registry = self
            .registry
            .try_lock()
            .map_err(|_| "Background registry busy; retry")?;
        if registry.closed
            || registry
                .closed_sessions
                .contains(&(scope.owner.clone(), scope.session.clone()))
        {
            return Err("Background session is closed".into());
        }
        let entry = registry
            .entries
            .get(&Ledger::key(scope, action_id)?)
            .filter(|entry| entry.scope == *scope)
            .cloned()
            .ok_or("Background output is unavailable; it is not retained across restarts")?;
        let gate = self
            .owner_gate
            .as_ref()
            .ok_or("Background owner control unavailable")?;
        let (snapshot, confirmed) = gate.admit_generation(&scope.owner, generation, || {
            cancellation.admit(|| {
                if super::interaction::now_ms() >= expires_at {
                    return Err("Background authorization expired".into());
                }
                let state = entry
                    .state
                    .lock()
                    .map_err(|_| "Background state unavailable")?
                    .clone();
                let stdout = entry
                    .stdout
                    .lock()
                    .map_err(|_| "Background output unavailable")?;
                let stderr = entry
                    .stderr
                    .lock()
                    .map_err(|_| "Background output unavailable")?;
                Ok(BackgroundSnapshot {
                    state,
                    stdout: stdout.text(),
                    stderr: stderr.text(),
                    stdout_truncated: stdout.truncated
                        || stdout.failed
                        || stdout.text().len() < String::from_utf8_lossy(&stdout.bytes).len(),
                    stderr_truncated: stderr.truncated
                        || stderr.failed
                        || stderr.text().len() < String::from_utf8_lossy(&stderr.bytes).len(),
                    output_withheld: false,
                })
            })
        })?;
        if !confirmed {
            return Err("Background output release could not be confirmed".into());
        }
        Ok(snapshot)
    }

    // Output is kept only in the live manager. The tool layer must obtain an
    // explicit approval for this exact immutable snapshot before releasing it.
    pub(super) async fn reviewable_output(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<BackgroundSnapshot, String> {
        let entry = self.entry(scope, action_id).await?;
        let state = entry
            .state
            .lock()
            .map_err(|_| "Background state unavailable")?
            .clone();
        let stdout = entry
            .stdout
            .lock()
            .map_err(|_| "Background output unavailable")?;
        let stderr = entry
            .stderr
            .lock()
            .map_err(|_| "Background output unavailable")?;
        Ok(BackgroundSnapshot {
            state,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdout_truncated: stdout.truncated
                || stdout.failed
                || stdout.text().len() < String::from_utf8_lossy(&stdout.bytes).len(),
            stderr_truncated: stderr.truncated
                || stderr.failed
                || stderr.text().len() < String::from_utf8_lossy(&stderr.bytes).len(),
            output_withheld: false,
        })
    }
    pub(crate) async fn wait(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
        timeout: Duration,
        cancellation: &super::interaction::Cancellation,
    ) -> Result<BackgroundSnapshot, String> {
        if timeout.is_zero() || timeout > Duration::from_secs(30) {
            return Err("Invalid background wait timeout".into());
        }
        cancellation.check()?;
        let entry = match self.entry(scope, action_id).await {
            Ok(entry) => entry,
            Err(_) => {
                let snapshot = self.snapshot(scope, action_id).await?;
                cancellation.check()?;
                return Ok(snapshot);
            }
        };
        let mut done = entry.done.subscribe();
        let completion = async {
            while !*done.borrow_and_update() {
                done.changed()
                    .await
                    .map_err(|_| "Background completion is unavailable".to_owned())?;
            }
            Ok(())
        };
        match tokio::time::timeout(timeout, cancellation.run(completion)).await {
            Ok(result) => result?,
            Err(_) => cancellation.check()?,
        }
        cancellation.check()?;
        self.snapshot(scope, action_id).await
    }
    pub(super) async fn cancel(
        &self,
        scope: &BackgroundScope,
        action_id: &str,
    ) -> Result<(), String> {
        match self.entry(scope, action_id).await {
            Ok(entry) => {
                let _ = entry.cancel.send(true);
                Ok(())
            }
            Err(_) => match self.ledger.read(scope, action_id)? {
                BackgroundState::Unknown
                | BackgroundState::CleanupUnconfirmed
                | BackgroundState::Running => Err(
                    "Background action ownership is unknown; cancellation cannot be confirmed"
                        .into(),
                ),
                _ => Ok(()),
            },
        }
    }
    // Closes admission for this owner/session and waits for every live process.
    // Durable receipts are retained for deduplication, including after deletion.
    pub(crate) async fn cleanup_session(&self, owner: &str, session: &str) -> Result<(), String> {
        let entries: Vec<_> = {
            let mut registry = self.registry.lock().await;
            registry
                .closed_sessions
                .insert((owner.to_owned(), session.to_owned()));
            let entries = registry
                .entries
                .values()
                .filter(|entry| entry.scope.owner == owner && entry.scope.session == session)
                .cloned()
                .collect::<Vec<_>>();
            for entry in &entries {
                let _ = entry.cancel.send(true);
            }
            entries
        };
        let mut unconfirmed = false;
        for entry in entries {
            let mut done = entry.done.subscribe();
            while !*done.borrow_and_update() {
                done.changed()
                    .await
                    .map_err(|_| "Background cleanup is unconfirmed")?;
            }
            if matches!(
                *entry.state.lock().unwrap(),
                BackgroundState::CleanupUnconfirmed | BackgroundState::Unknown
            ) {
                unconfirmed = true;
            }
        }
        if unconfirmed || self.ledger.has_unknown(Some((owner, session)))? {
            return Err("Background cleanup is unconfirmed".into());
        }
        Ok(())
    }

    /// The caller holds the session deletion fence and has established that
    /// deletion failed before any durable session tombstone was written.
    pub(crate) async fn reopen_after_uncommitted_deletion(
        &self,
        owner: &str,
        session: &str,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().await;
        if registry.closed
            || self.ledger.is_retired(owner, session)?
            || self.ledger.has_unknown(Some((owner, session)))?
        {
            return Err("Background session cleanup is unconfirmed".into());
        }
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.scope.owner == owner && entry.scope.session == session)
        {
            let state = entry
                .state
                .lock()
                .map_err(|_| "Background session cleanup is unconfirmed")?;
            if !*entry.done.borrow()
                || matches!(
                    *state,
                    BackgroundState::Running
                        | BackgroundState::CleanupUnconfirmed
                        | BackgroundState::Unknown
                )
            {
                return Err("Background session cleanup is unconfirmed".into());
            }
        }
        registry
            .closed_sessions
            .remove(&(owner.to_owned(), session.to_owned()));
        Ok(())
    }
    // The caller must authenticate and hold the session deletion fence. The
    // tombstone permanently rejects new actions even if deletion later fails.
    pub(crate) async fn retire_session(&self, owner: &str, session: &str) -> Result<(), String> {
        if owner.is_empty() || session.is_empty() || owner.len() > 256 || session.len() > 256 {
            return Err("Invalid background session".into());
        }
        self.cleanup_session(owner, session).await?;
        let mut registry = self.registry.lock().await;
        self.ledger.retire_session(owner, session)?;
        registry
            .entries
            .retain(|_, entry| entry.scope.owner != owner || entry.scope.session != session);
        registry
            .closed_sessions
            .remove(&(owner.to_owned(), session.to_owned()));
        for worker in std::mem::take(&mut registry.workers) {
            if worker.is_finished() {
                registry.shutdown_failed |= worker.await.is_err();
            } else {
                registry.workers.push(worker);
            }
        }
        if registry.shutdown_failed {
            return Err("Background cleanup is unconfirmed".into());
        }
        Ok(())
    }
    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        #[cfg(all(test, unix))]
        {
            let mut lifecycle = self
                .coordinator_lifecycle
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *lifecycle = false;
        }
        let mut registry = self.registry.lock().await;
        registry.closed = true;
        for entry in registry.entries.values() {
            let _ = entry.cancel.send(true);
        }
        // Holding the registry lock makes concurrent shutdown callers wait for
        // the same reaping barrier, and excludes new starts until it completes.
        while let Some(worker) = registry.workers.last_mut() {
            let failed = worker.await.is_err();
            registry.workers.pop();
            registry.shutdown_failed |= failed;
        }
        if registry.shutdown_failed
            || self.ledger.has_unknown(None)?
            || registry.entries.values().any(|entry| {
                matches!(
                    *entry.state.lock().unwrap(),
                    BackgroundState::CleanupUnconfirmed | BackgroundState::Unknown
                )
            })
        {
            return Err("Background cleanup is unconfirmed".into());
        }
        Ok(())
    }
}
impl Drop for BackgroundProcesses {
    fn drop(&mut self) {
        if let Ok(registry) = self.registry.try_lock() {
            for entry in registry.entries.values() {
                let _ = entry.cancel.send(true);
            }
        }
    }
}
async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin, entry: Arc<Entry>, stdout: bool) {
    let mut buffer = [0; 8192];
    loop {
        let read = pipe.read(&mut buffer).await;
        let mut output = if stdout {
            entry.stdout.lock().unwrap()
        } else {
            entry.stderr.lock().unwrap()
        };
        match read {
            Ok(0) => break,
            Ok(count) => {
                let retained = count.min(OUTPUT_LIMIT.saturating_sub(output.bytes.len()));
                output.bytes.extend_from_slice(&buffer[..retained]);
                output.truncated |= retained < count;
            }
            Err(_) => {
                output.failed = true;
                break;
            }
        }
    }
}
async fn run(
    entry: Arc<Entry>,
    mut child: tokio::process::Child,
    tree: crate::process_tree::ProcessTree,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    #[cfg(unix)] status: tokio::net::UnixStream,
    mut cancel: watch::Receiver<bool>,
    timeout: Duration,
) -> BackgroundState {
    let mut out = tokio::spawn(drain(stdout, entry.clone(), true));
    let mut err = tokio::spawn(drain(stderr, entry.clone(), false));
    #[cfg(unix)]
    let mut state = tokio::select! {
        biased;
        code = watchdog::exit_code(status) => match code { Ok(code) => BackgroundState::Exited { code: Some(code) }, Err(_) => BackgroundState::CleanupUnconfirmed },
        _ = tree.wait(&mut child) => BackgroundState::CleanupUnconfirmed,
        _ = cancel.changed() => BackgroundState::Cancelled,
        _ = tokio::time::sleep(timeout) => BackgroundState::TimedOut,
    };
    #[cfg(windows)]
    let mut state = tokio::select! {
        biased;
        status = tree.wait(&mut child) => match status { Ok(status) => BackgroundState::Exited { code: status.code() }, Err(_) => BackgroundState::CleanupUnconfirmed },
        _ = cancel.changed() => BackgroundState::Cancelled,
        _ = tokio::time::sleep(timeout) => BackgroundState::TimedOut,
    };
    #[cfg(windows)]
    if matches!(
        state,
        BackgroundState::Cancelled | BackgroundState::TimedOut
    ) {
        match tree.try_wait(&mut child) {
            Ok(Some(status)) => {
                state = BackgroundState::Exited {
                    code: status.code(),
                }
            }
            Ok(None) => {}
            Err(_) => state = BackgroundState::CleanupUnconfirmed,
        }
    }
    let (stopped, waited) = tokio::join!(
        tree.stop(Duration::from_millis(500)),
        tokio::time::timeout(Duration::from_secs(2), tree.wait(&mut child))
    );
    if stopped.is_err() || !matches!(waited, Ok(Ok(_))) {
        let _ = child.start_kill();
        state = BackgroundState::CleanupUnconfirmed;
    }
    let (out_result, err_result) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(2), &mut out),
        tokio::time::timeout(Duration::from_secs(2), &mut err)
    );
    if !matches!(out_result, Ok(Ok(())))
        || !matches!(err_result, Ok(Ok(())))
        || entry.stdout.lock().unwrap().failed
        || entry.stderr.lock().unwrap().failed
    {
        out.abort();
        err.abort();
        state = BackgroundState::CleanupUnconfirmed;
    }
    state
}

#[cfg(all(test, unix))]
#[path = "background_lifecycle_tests.rs"]
mod lifecycle_tests;
#[cfg(test)]
#[path = "background_process_tests.rs"]
mod tests;
