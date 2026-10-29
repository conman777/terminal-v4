//! Durable logout holds and cleanup acknowledgements for structured owners.
//!
//! The caller must hold the existing owner lease throughout cleanup and check
//! holds at every owner admission. This module does not itself stop sessions or
//! revoke credentials.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
#[cfg(test)]
use std::time::Duration;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
};
use uuid::Uuid;

const MAX_HOLDS: i64 = 4096;

pub(crate) struct OwnerCleanup {
    db: Arc<Mutex<Connection>>,
    fence: Option<AdmissionFence>,
    root: Option<std::path::PathBuf>,
    owners: Mutex<HashMap<String, Weak<OwnerEntry>>>,
    lifecycle: Mutex<WorkerState>,
    workers_idle: tokio::sync::Notify,
}

#[derive(Default)]
struct WorkerState {
    closing: bool,
    active: usize,
}

struct WorkerPermit {
    cleanup: Arc<OwnerCleanup>,
}

impl Drop for WorkerPermit {
    fn drop(&mut self) {
        let mut state = self
            .cleanup
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active -= 1;
        if state.active == 0 {
            self.cleanup.workers_idle.notify_waiters();
        }
    }
}

pub(crate) type FenceGuard = Box<dyn Send>;
pub(crate) type FenceAcquire = Arc<dyn Fn() -> Result<FenceGuard, String> + Send + Sync>;
pub(crate) type FenceValidate = Arc<dyn Fn(&Connection) -> Result<(), String> + Send + Sync>;

struct AdmissionFence {
    acquire: FenceAcquire,
    validate: FenceValidate,
}

#[derive(Default)]
struct OwnerEntry {
    serial: tokio::sync::Mutex<()>,
    state: Mutex<OwnerState>,
    idle: tokio::sync::Notify,
}

#[derive(Default)]
struct OwnerState {
    blocked: bool,
    inflight: usize,
}

pub(crate) struct OwnerPermit {
    entry: Arc<OwnerEntry>,
}

impl Drop for OwnerPermit {
    fn drop(&mut self) {
        let mut state = self
            .entry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.inflight -= 1;
        if state.inflight == 0 {
            self.entry.idle.notify_waiters();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    owner: String,
    id: Uuid,
}

impl Request {
    pub(super) fn owner(&self) -> &str {
        &self.owner
    }
    pub(super) fn id(&self) -> Uuid {
        self.id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Receipt {
    request: Request,
    lease_epoch: Uuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CleanupResource {
    Structured,
    Delegation,
    Background,
}

impl CleanupResource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Structured => "structured",
            Self::Delegation => "delegation",
            Self::Background => "background",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CleanupIssue {
    Unconfirmed,
    Unavailable,
}

impl CleanupIssue {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unconfirmed => "unconfirmed",
            Self::Unavailable => "unavailable",
        }
    }
}

fn valid_owner(owner: &str) -> Result<(), String> {
    if owner.trim().is_empty() || owner.len() > 256 || owner.chars().any(char::is_control) {
        return Err("Invalid cleanup owner".into());
    }
    Ok(())
}

impl OwnerCleanup {
    fn entry(&self, owner: &str) -> Result<Arc<OwnerEntry>, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "Owner cleanup unavailable")?;
        owners.retain(|_, gate| gate.strong_count() > 0);
        if let Some(entry) = owners.get(owner).and_then(Weak::upgrade) {
            return Ok(entry);
        }
        if owners.len() >= MAX_HOLDS as usize {
            return Err("Owner cleanup capacity reached".into());
        }
        let entry = Arc::new(OwnerEntry::default());
        owners.insert(owner.into(), Arc::downgrade(&entry));
        Ok(entry)
    }

    /// The caller must already own the live-owner lease and hold its global
    /// shutdown admission permit. This transaction orders entry with logout.
    pub(super) fn enter(&self, owner: &str) -> Result<OwnerPermit, String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let mut db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Owner cleanup unavailable")?;
        let held: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
                [owner],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if held {
            return Err("Owner cleanup is in progress".into());
        }
        let entry = self.entry(owner)?;
        {
            let mut state = entry
                .state
                .lock()
                .map_err(|_| "Owner cleanup unavailable")?;
            if state.blocked {
                return Err("Owner cleanup is in progress".into());
            }
            state.inflight = state
                .inflight
                .checked_add(1)
                .ok_or("Owner admission capacity reached")?;
        }
        let permit = OwnerPermit { entry };
        self.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Owner admission outcome is uncertain")?;
        Ok(permit)
    }

    /// Open an already-provisioned, durable registry; missing tables fail closed.
    #[cfg(test)]
    pub(super) fn open(db: Connection) -> Result<Self, String> {
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|_| "Owner cleanup unavailable")?;
        let sync: i64 = db
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(|_| "Owner cleanup unavailable")?;
        let journal: String = db
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .map_err(|_| "Owner cleanup unavailable")?;
        if sync < 2 || matches!(journal.to_ascii_lowercase().as_str(), "off" | "memory") {
            return Err("Owner cleanup requires durable SQLite settings".into());
        }
        db.prepare("SELECT owner,request FROM structured_owner_holds LIMIT 0")
            .map_err(|_| "Owner cleanup holds are unavailable")?;
        db.prepare(
            "SELECT owner,request,lease_epoch FROM structured_owner_cleanup_receipts LIMIT 0",
        )
        .map_err(|_| "Owner cleanup receipts are unavailable")?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            fence: None,
            root: None,
            owners: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(WorkerState::default()),
            workers_idle: tokio::sync::Notify::new(),
        })
    }

    pub(crate) fn bind_shared(
        root: std::path::PathBuf,
        db: Arc<Mutex<Connection>>,
        acquire: FenceAcquire,
        validate: FenceValidate,
    ) -> Result<Self, String> {
        let fence = AdmissionFence { acquire, validate };
        let _guard = (fence.acquire)()?;
        {
            let connection = db.lock().map_err(|_| "Owner cleanup unavailable")?;
            (fence.validate)(&connection)?;
            connection
                .prepare("SELECT owner,request FROM structured_owner_holds LIMIT 0")
                .map_err(|_| "Owner cleanup holds are unavailable")?;
            connection.prepare("SELECT owner,request,lease_epoch FROM structured_owner_cleanup_receipts LIMIT 0").map_err(|_| "Owner cleanup receipts are unavailable")?;
        }
        Ok(Self {
            db,
            fence: Some(fence),
            root: Some(root),
            owners: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(WorkerState::default()),
            workers_idle: tokio::sync::Notify::new(),
        })
    }

    pub(super) fn root(&self) -> Option<&std::path::Path> {
        self.root.as_deref()
    }

    fn acquire(&self) -> Result<Option<FenceGuard>, String> {
        self.fence
            .as_ref()
            .map(|fence| (fence.acquire)())
            .transpose()
    }

    fn validate(&self, db: &Connection) -> Result<(), String> {
        if let Some(fence) = &self.fence {
            (fence.validate)(db)?;
        }
        Ok(())
    }

    /// Commit this in the same transaction as credential revocation. Renewing
    /// an existing request invalidates its earlier cleanup receipt atomically.
    pub(crate) fn hold_in_transaction(
        tx: &Transaction<'_>,
        owner: &str,
        id: Uuid,
    ) -> Result<Request, String> {
        valid_owner(owner)?;
        if id.is_nil() {
            return Err("Invalid cleanup request".into());
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT request FROM structured_owner_holds WHERE owner=?1",
                [owner],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if existing.as_deref() == Some(id.to_string().as_str()) {
            return Ok(Request {
                owner: owner.into(),
                id,
            });
        }
        if existing.is_none() {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM structured_owner_holds", [], |r| {
                    r.get(0)
                })
                .map_err(|_| "Cannot inspect owner cleanup holds")?;
            if count >= MAX_HOLDS {
                return Err("Owner cleanup capacity reached".into());
            }
        }
        tx.execute(
            "DELETE FROM structured_owner_cleanup_receipts WHERE owner=?1",
            [owner],
        )
        .map_err(|_| "Cannot renew owner cleanup")?;
        tx.execute(
            "DELETE FROM structured_owner_delegation_receipts WHERE owner=?1",
            [owner],
        )
        .map_err(|_| "Cannot renew delegation cleanup")?;
        tx.execute(
            "DELETE FROM structured_owner_cleanup_issues WHERE owner=?1",
            [owner],
        )
        .map_err(|_| "Cannot renew owner cleanup diagnostics")?;
        tx.execute("INSERT INTO structured_owner_holds(owner,request) VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET request=excluded.request", params![owner, id.to_string()])
            .map_err(|_| "Cannot persist owner cleanup hold")?;
        Ok(Request {
            owner: owner.into(),
            id,
        })
    }

    #[cfg(test)]
    pub(super) fn is_held(&self, owner: &str) -> Result<bool, String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1)",
            [owner],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot inspect owner cleanup hold".into())
    }

    pub(super) fn pending_owners(&self) -> Result<Vec<String>, String> {
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let mut query = db.prepare("SELECT h.owner FROM structured_owner_holds h LEFT JOIN structured_owner_cleanup_receipts r ON r.owner=h.owner AND r.request=h.request WHERE r.owner IS NULL ORDER BY h.owner LIMIT 4096")
            .map_err(|_| "Cannot inspect owner cleanup holds")?;
        let owners = query
            .query_map([], |r| r.get(0))
            .map_err(|_| "Cannot inspect owner cleanup holds")?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|_| "Cannot inspect owner cleanup holds")?;
        for owner in &owners {
            valid_owner(owner)?;
        }
        Ok(owners)
    }

    pub(super) fn requests(&self) -> Result<Vec<Request>, String> {
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let mut query = db
            .prepare("SELECT owner,request FROM structured_owner_holds ORDER BY owner LIMIT 4096")
            .map_err(|_| "Cannot inspect owner cleanup holds")?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| "Cannot inspect owner cleanup holds")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot inspect owner cleanup holds")?;
        rows.into_iter()
            .map(|(owner, id)| {
                valid_owner(&owner)?;
                let id = Uuid::parse_str(&id).map_err(|_| "Invalid owner cleanup request")?;
                if id.is_nil() {
                    return Err("Invalid owner cleanup request".into());
                }
                Ok(Request { owner, id })
            })
            .collect()
    }

    pub(super) fn record_delegation_receipt(
        &self,
        owner: &str,
        request: Uuid,
        supervisor: Uuid,
        outbox: &str,
    ) -> Result<(), String> {
        valid_owner(owner)?;
        if request.is_nil()
            || supervisor.is_nil()
            || outbox.len() != 64
            || !outbox.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid delegation cleanup receipt".into());
        }
        let _fence = self.acquire()?;
        let mut db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Owner cleanup unavailable")?;
        let matches: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1 AND request=?2)",
                params![owner, request.to_string()],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if !matches {
            return Err("Owner cleanup request changed".into());
        }
        tx.execute("INSERT INTO structured_owner_delegation_receipts(owner,request,supervisor_instance,outbox_identity) VALUES(?1,?2,?3,?4) ON CONFLICT(owner) DO UPDATE SET request=excluded.request,supervisor_instance=excluded.supervisor_instance,outbox_identity=excluded.outbox_identity", params![owner,request.to_string(),supervisor.to_string(),outbox]).map_err(|_| "Cannot persist delegation cleanup receipt")?;
        self.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Delegation cleanup receipt outcome is uncertain".into())
    }

    pub(crate) fn record_delegation_review(
        tx: &Transaction<'_>,
        owner: &str,
        request: Uuid,
        operation: Uuid,
        child_operation: Uuid,
        task: Uuid,
        child: Uuid,
        outbox: &str,
    ) -> Result<(), String> {
        valid_owner(owner)?;
        if request.is_nil()
            || operation.is_nil()
            || child_operation.is_nil()
            || task.is_nil()
            || child.is_nil()
            || outbox.len() != 64
            || !outbox.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid delegation review scope".into());
        }
        let held: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1 AND request=?2)",
                params![owner, request.to_string()],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if !held {
            return Err("Owner cleanup request changed".into());
        }
        tx.execute("INSERT INTO structured_owner_delegation_reviews(owner,request,operation,child_operation,task,child_session,outbox_identity) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(owner,operation) DO NOTHING", params![owner,request.to_string(),operation.to_string(),child_operation.to_string(),task.to_string(),child.to_string(),outbox]).map_err(|_| "Cannot persist delegation review")?;
        let matching: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_delegation_reviews WHERE owner=?1 AND request=?2 AND operation=?3 AND child_operation=?4 AND task=?5 AND child_session=?6 AND outbox_identity=?7)", params![owner,request.to_string(),operation.to_string(),child_operation.to_string(),task.to_string(),child.to_string(),outbox], |row| row.get(0)).map_err(|_| "Cannot inspect delegation review")?;
        if !matching {
            return Err("Delegation review identity changed".into());
        }
        Ok(())
    }

    /// Call only while the exact delegation supervisor fence is retained.
    /// Background-enabled installations fail closed until their own cleanup
    /// receipt can be validated in this same release transaction.
    pub(super) fn release_after_delegation<G>(
        &self,
        owner: &str,
        request: Uuid,
        supervisor: Uuid,
        outbox: &str,
        background: impl FnOnce(&Transaction<'_>, bool) -> Result<G, String>,
    ) -> Result<(), String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let mut db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Owner cleanup unavailable")?;
        let background_installed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |r| r.get(0)).map_err(|_| "Cannot inspect background installation")?;
        let _background_guard = background(&tx, background_installed)?;
        let matching: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_holds h JOIN structured_owner_cleanup_receipts s ON s.owner=h.owner AND s.request=h.request JOIN structured_owner_delegation_receipts d ON d.owner=h.owner AND d.request=h.request WHERE h.owner=?1 AND h.request=?2 AND d.supervisor_instance=?3 AND d.outbox_identity=?4)", params![owner, request.to_string(), supervisor.to_string(), outbox], |r| r.get(0)).map_err(|_| "Cannot inspect owner cleanup receipts")?;
        if !matching {
            return Err("Owner cleanup receipts are missing or stale".into());
        }
        tx.execute(
            "DELETE FROM structured_owner_cleanup_receipts WHERE owner=?1 AND request=?2",
            params![owner, request.to_string()],
        )
        .map_err(|_| "Cannot remove owner cleanup receipt")?;
        tx.execute(
            "DELETE FROM structured_owner_delegation_receipts WHERE owner=?1 AND request=?2",
            params![owner, request.to_string()],
        )
        .map_err(|_| "Cannot remove delegation cleanup receipt")?;
        tx.execute(
            "DELETE FROM structured_owner_cleanup_issues WHERE owner=?1 AND request=?2",
            params![owner, request.to_string()],
        )
        .map_err(|_| "Cannot remove owner cleanup diagnostics")?;
        let removed = tx
            .execute(
                "DELETE FROM structured_owner_holds WHERE owner=?1 AND request=?2",
                params![owner, request.to_string()],
            )
            .map_err(|_| "Cannot release owner cleanup hold")?;
        if removed != 1 {
            return Err("Owner cleanup request changed".into());
        }
        self.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Owner cleanup release outcome is uncertain".into())
    }

    pub(super) fn background_installed(&self) -> Result<bool, String> {
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |r| r.get(0)).map_err(|_| "Cannot inspect background installation".into())
    }

    pub(super) fn background_was_reviewed(
        &self,
        owner: &str,
        request: Option<Uuid>,
    ) -> Result<bool, String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_background_reviews WHERE owner=?1 AND (?2 IS NULL OR request=?2))", params![owner, request.map(|value| value.to_string())], |row| row.get(0)).map_err(|_| "Background review audit is unavailable".into())
    }

    pub(super) fn delegation_was_reviewed(
        &self,
        owner: &str,
        request: Option<Uuid>,
    ) -> Result<bool, String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_delegation_reviews WHERE owner=?1 AND (?2 IS NULL OR request=?2))", params![owner, request.map(|value| value.to_string())], |row| row.get(0)).map_err(|_| "Delegation review audit is unavailable".into())
    }

    pub(super) fn delegation_review_receipt(
        &self,
        owner: &str,
        operation: Uuid,
    ) -> Result<Option<serde_json::Value>, String> {
        valid_owner(owner)?;
        if operation.is_nil() {
            return Err("Invalid delegation review identity".into());
        }
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row("SELECT request,child_operation,task,child_session FROM structured_owner_delegation_reviews WHERE owner=?1 AND operation=?2", params![owner,operation.to_string()], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).optional().map_err(|_| "Cannot inspect delegation review".to_string()).and_then(|row| row.map(|(request,child_operation,task,child)| {
            let request = Uuid::parse_str(&request).map_err(|_| "Invalid delegation review".to_string())?;
            let child_operation = Uuid::parse_str(&child_operation).map_err(|_| "Invalid delegation review".to_string())?;
            let task = Uuid::parse_str(&task).map_err(|_| "Invalid delegation review".to_string())?;
            let child = Uuid::parse_str(&child).map_err(|_| "Invalid delegation review".to_string())?;
            Ok(serde_json::json!({"status":"reviewed","requestId":request,"operationId":operation,"childOperationId":child_operation,"taskId":task,"childSessionId":child}))
        }).transpose())
    }

    pub(super) fn background_status(
        &self,
        owner: &str,
        request: Option<Uuid>,
    ) -> Result<&'static str, String> {
        valid_owner(owner)?;
        let root = self
            .root
            .as_deref()
            .ok_or("Owner cleanup root unavailable")?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let installed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_ledger_installation')", [], |row| row.get(0)).map_err(|_| "Cannot inspect background installation")?;
        if !installed {
            for path in [
                root.join("background-processes"),
                root.join(".background-processes.background-guard"),
            ] {
                match std::fs::symlink_metadata(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Ok("unavailable"),
                }
            }
            return Ok("not_installed");
        }
        let state: Option<String> = db
            .query_row(
                "SELECT state FROM background_ledger_installation WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect background installation")?;
        if state.as_deref() != Some("ready") {
            return Ok("unavailable");
        }
        if crate::v4_agent::background_quiescence::capture_binding(root, None).is_err() {
            return Ok("unavailable");
        }
        let hold: Option<String> = db
            .query_row(
                "SELECT request FROM background_owner_holds WHERE owner=?1",
                [owner],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect background cleanup hold")?;
        Ok(match (request, hold) {
            (Some(request), Some(hold)) if hold == request.to_string() => "pending",
            (None, None) => "confirmed",
            _ => "unavailable",
        })
    }

    pub(super) fn open_existing_background(
        &self,
    ) -> Result<crate::v4_agent::background_process::bootstrap::ExistingInstallation, String> {
        let root = self
            .root
            .as_deref()
            .ok_or("Owner cleanup root unavailable")?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        crate::v4_agent::background_process::bootstrap::open_existing(root, &db)
    }

    pub(super) fn pending(&self, owner: &str) -> Result<Option<Request>, String> {
        valid_owner(owner)?;
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let id: Option<String> = db
            .query_row(
                "SELECT request FROM structured_owner_holds WHERE owner=?1",
                [owner],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        id.map(|id| {
            Uuid::parse_str(&id)
                .map(|id| Request {
                    owner: owner.into(),
                    id,
                })
                .map_err(|_| "Invalid owner cleanup request".into())
        })
        .transpose()
    }

    pub(super) fn delegation_reviewed(
        &self,
        owner: &str,
        request: Uuid,
        child_operation: Uuid,
        task: Uuid,
        child: Uuid,
        outbox: &str,
    ) -> Result<bool, String> {
        valid_owner(owner)?;
        if request.is_nil()
            || child_operation.is_nil()
            || task.is_nil()
            || child.is_nil()
            || outbox.len() != 64
            || !outbox.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid delegation review scope".into());
        }
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        db.query_row("SELECT EXISTS(SELECT 1 FROM structured_owner_delegation_reviews r JOIN structured_owner_holds h ON h.owner=r.owner AND h.request=r.request WHERE r.owner=?1 AND r.request=?2 AND r.child_operation=?3 AND r.task=?4 AND r.child_session=?5 AND r.outbox_identity=?6)", params![owner,request.to_string(),child_operation.to_string(),task.to_string(),child.to_string(),outbox], |row| row.get(0)).map_err(|_| "Cannot inspect delegation review".into())
    }

    pub(super) fn record_issue(
        &self,
        request: &Request,
        resource: CleanupResource,
        issue: Option<CleanupIssue>,
    ) -> Result<(), String> {
        let _fence = self.acquire()?;
        let mut db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Owner cleanup unavailable")?;
        let matches: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM structured_owner_holds WHERE owner=?1 AND request=?2)",
                params![request.owner, request.id.to_string()],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if !matches {
            return Err("Owner cleanup request changed".into());
        }
        if let Some(issue) = issue {
            tx.execute("INSERT INTO structured_owner_cleanup_issues(owner,request,resource,code) VALUES(?1,?2,?3,?4) ON CONFLICT(owner,request,resource) DO UPDATE SET code=excluded.code", params![request.owner, request.id.to_string(), resource.as_str(), issue.as_str()]).map_err(|_| "Cannot persist owner cleanup diagnostics")?;
        } else {
            tx.execute("DELETE FROM structured_owner_cleanup_issues WHERE owner=?1 AND request=?2 AND resource=?3", params![request.owner, request.id.to_string(), resource.as_str()]).map_err(|_| "Cannot clear owner cleanup diagnostics")?;
        }
        self.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Owner cleanup diagnostics outcome is uncertain".into())
    }

    pub(super) fn issues(
        &self,
        request: &Request,
    ) -> Result<Vec<(CleanupResource, CleanupIssue)>, String> {
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let mut query = db.prepare("SELECT resource,code FROM structured_owner_cleanup_issues WHERE owner=?1 AND request=?2 ORDER BY resource").map_err(|_| "Cannot inspect owner cleanup diagnostics")?;
        let rows = query
            .query_map(params![request.owner, request.id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "Cannot inspect owner cleanup diagnostics")?;
        rows.map(|row| {
            let (resource, issue) = row.map_err(|_| "Cannot inspect owner cleanup diagnostics")?;
            let resource = match resource.as_str() {
                "structured" => CleanupResource::Structured,
                "delegation" => CleanupResource::Delegation,
                "background" => CleanupResource::Background,
                _ => return Err("Invalid owner cleanup diagnostic".into()),
            };
            let issue = match issue.as_str() {
                "unconfirmed" => CleanupIssue::Unconfirmed,
                "unavailable" => CleanupIssue::Unavailable,
                _ => return Err("Invalid owner cleanup diagnostic".into()),
            };
            Ok((resource, issue))
        })
        .collect()
    }

    pub(super) fn receipt(&self, request: &Request) -> Result<Option<Receipt>, String> {
        let _fence = self.acquire()?;
        let db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let epoch: Option<String> = db.query_row("SELECT r.lease_epoch FROM structured_owner_cleanup_receipts r JOIN structured_owner_holds h ON r.owner=h.owner AND r.request=h.request WHERE r.owner=?1 AND r.request=?2", params![request.owner, request.id.to_string()], |r| r.get(0))
            .optional().map_err(|_| "Cannot inspect owner cleanup receipt")?;
        epoch
            .map(|epoch| {
                Uuid::parse_str(&epoch)
                    .map(|lease_epoch| Receipt {
                        request: request.clone(),
                        lease_epoch,
                    })
                    .map_err(|_| "Invalid owner cleanup receipt".into())
            })
            .transpose()
    }

    /// Only the process retaining the owner's validated lease may call this.
    /// `lease` returns the same non-nil lease epoch while that lease is held.
    /// Admission must already reject the persisted hold before cleanup starts.
    pub(super) async fn service<F, C, Fut, G>(
        self: &Arc<Self>,
        owner: &str,
        lease: F,
        cleanup: C,
    ) -> Result<Option<Receipt>, String>
    where
        F: Fn() -> Result<Option<Uuid>, String> + Send + 'static,
        C: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<G, String>> + Send + 'static,
        G: Send + 'static,
    {
        let gate = self.clone();
        let owner = owner.to_owned();
        self.run_owned(async move { gate.service_owned(&owner, lease, cleanup).await })
            .await
    }

    pub(super) async fn run_owned<T, F>(self: &Arc<Self>, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let permit = {
            let mut state = self
                .lifecycle
                .lock()
                .map_err(|_| "Owner cleanup unavailable")?;
            if state.closing {
                return Err("Owner cleanup is shutting down".into());
            }
            state.active = state
                .active
                .checked_add(1)
                .ok_or("Owner cleanup capacity reached")?;
            WorkerPermit {
                cleanup: self.clone(),
            }
        };
        tokio::spawn(async move {
            let _permit = permit;
            work.await
        })
        .await
        .map_err(|_| "Owner cleanup worker stopped".to_string())?
    }

    pub(super) async fn shutdown(&self) -> Result<(), String> {
        self.lifecycle
            .lock()
            .map_err(|_| "Owner cleanup unavailable")?
            .closing = true;
        loop {
            let notified = self.workers_idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .lifecycle
                .lock()
                .map_err(|_| "Owner cleanup unavailable")?
                .active
                == 0
            {
                return Ok(());
            }
            notified.await;
        }
    }

    pub(super) fn reopen(&self) -> Result<(), String> {
        self.lifecycle
            .lock()
            .map_err(|_| "Owner cleanup unavailable")?
            .closing = false;
        Ok(())
    }

    async fn service_owned<F, C, Fut, G>(
        &self,
        owner: &str,
        lease: F,
        cleanup: C,
    ) -> Result<Option<Receipt>, String>
    where
        F: Fn() -> Result<Option<Uuid>, String>,
        C: FnOnce() -> Fut,
        Fut: Future<Output = Result<G, String>>,
    {
        valid_owner(owner)?;
        let owner_gate = self.entry(owner)?;
        let _serial = owner_gate.serial.lock().await;
        let Some(request) = self.pending(owner)? else {
            return Ok(None);
        };
        let Some(epoch) = lease()? else {
            return Ok(None);
        };
        if epoch.is_nil() {
            return Err("Invalid owner lease".into());
        }
        if let Some(receipt) = self.receipt(&request)? {
            if receipt.lease_epoch == epoch {
                return Ok(Some(receipt));
            }
            return Err("Owner cleanup receipt belongs to an earlier lease".into());
        }
        {
            let mut state = owner_gate
                .state
                .lock()
                .map_err(|_| "Owner cleanup unavailable")?;
            state.blocked = true;
        }
        loop {
            let notified = owner_gate.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if owner_gate
                .state
                .lock()
                .map_err(|_| "Owner cleanup unavailable")?
                .inflight
                == 0
            {
                break;
            }
            notified.await;
        }
        // The returned guard must prevent lease release until the receipt is
        // committed. Lease validation cannot take the owner lock while the
        // SQLite write transaction is held: acquisition uses the reverse order.
        let _lease_guard = cleanup().await?;
        if lease()? != Some(epoch) {
            return Err("Owner lease changed during cleanup".into());
        }
        let _fence = self.acquire()?;
        let mut db = self.db.lock().map_err(|_| "Owner cleanup unavailable")?;
        self.validate(&db)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "Owner cleanup unavailable")?;
        let current: Option<String> = tx
            .query_row(
                "SELECT request FROM structured_owner_holds WHERE owner=?1",
                [owner],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "Cannot inspect owner cleanup hold")?;
        if current.as_deref() != Some(request.id.to_string().as_str()) {
            return Err("Owner cleanup request or lease changed".into());
        }
        tx.execute("INSERT INTO structured_owner_cleanup_receipts(owner,request,lease_epoch) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET request=excluded.request,lease_epoch=excluded.lease_epoch", params![owner, request.id.to_string(), epoch.to_string()])
            .map_err(|_| "Cannot persist owner cleanup receipt")?;
        self.validate(&tx)?;
        tx.commit()
            .map_err(|_| "Owner cleanup receipt outcome is uncertain")?;
        Ok(Some(Receipt {
            request,
            lease_epoch: epoch,
        }))
    }

    /// Caller must independently confirm cleanup of all other owner resources
    /// under the appropriate lifecycle gates before committing this release.
    #[cfg(test)]
    pub(super) fn release_in_transaction(
        tx: &Transaction<'_>,
        receipt: &Receipt,
    ) -> Result<(), String> {
        let changed = tx.execute("DELETE FROM structured_owner_holds WHERE owner=?1 AND request=?2 AND EXISTS(SELECT 1 FROM structured_owner_cleanup_receipts WHERE owner=?1 AND request=?2 AND lease_epoch=?3)", params![receipt.request.owner, receipt.request.id.to_string(), receipt.lease_epoch.to_string()])
            .map_err(|_| "Cannot release owner cleanup hold")?;
        if changed != 1 {
            return Err("Owner cleanup receipt is stale or missing".into());
        }
        tx.execute("DELETE FROM structured_owner_cleanup_receipts WHERE owner=?1 AND request=?2 AND lease_epoch=?3", params![receipt.request.owner, receipt.request.id.to_string(), receipt.lease_epoch.to_string()])
            .map_err(|_| "Cannot remove owner cleanup receipt")?;
        tx.execute(
            "DELETE FROM structured_owner_cleanup_issues WHERE owner=?1 AND request=?2",
            params![receipt.request.owner, receipt.request.id.to_string()],
        )
        .map_err(|_| "Cannot remove owner cleanup diagnostics")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Command, sync::Arc};

    fn no_background(_: &Transaction<'_>, installed: bool) -> Result<(), String> {
        if installed {
            Err("Background owner cleanup is not confirmed".into())
        } else {
            Ok(())
        }
    }

    fn database(path: &std::path::Path) -> Connection {
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE structured_owner_holds(owner TEXT PRIMARY KEY,request TEXT NOT NULL); CREATE TABLE structured_owner_cleanup_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,lease_epoch TEXT NOT NULL); CREATE TABLE structured_owner_delegation_receipts(owner TEXT PRIMARY KEY,request TEXT NOT NULL,supervisor_instance TEXT NOT NULL,outbox_identity TEXT NOT NULL); CREATE TABLE structured_owner_cleanup_issues(owner TEXT NOT NULL,request TEXT NOT NULL,resource TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(owner,request,resource)); CREATE TABLE structured_owner_delegation_reviews(owner TEXT NOT NULL,request TEXT NOT NULL,operation TEXT NOT NULL,child_operation TEXT NOT NULL,task TEXT NOT NULL,child_session TEXT NOT NULL,outbox_identity TEXT NOT NULL,PRIMARY KEY(owner,operation),UNIQUE(owner,request,child_operation))").unwrap();
        db
    }

    fn hold(db: &mut Connection, owner: &str, id: Uuid) -> Request {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let request = OwnerCleanup::hold_in_transaction(&tx, owner, id).unwrap();
        tx.commit().unwrap();
        request
    }

    #[test]
    fn delegation_review_is_bound_to_exact_hold_child_and_outbox() {
        let root = tempfile::tempdir().unwrap();
        let mut db = database(&root.path().join("state.sqlite"));
        let request = hold(&mut db, "owner", Uuid::new_v4());
        let operation = Uuid::new_v4();
        let child_operation = Uuid::new_v4();
        let task = Uuid::new_v4();
        let child = Uuid::new_v4();
        let identity = "a".repeat(64);
        let tx = db.transaction().unwrap();
        assert!(OwnerCleanup::record_delegation_review(
            &tx,
            "owner",
            Uuid::new_v4(),
            operation,
            child_operation,
            task,
            child,
            &identity
        )
        .is_err());
        OwnerCleanup::record_delegation_review(
            &tx,
            "owner",
            request.id(),
            operation,
            child_operation,
            task,
            child,
            &identity,
        )
        .unwrap();
        OwnerCleanup::record_delegation_review(
            &tx,
            "owner",
            request.id(),
            operation,
            child_operation,
            task,
            child,
            &identity,
        )
        .unwrap();
        assert!(OwnerCleanup::record_delegation_review(
            &tx,
            "owner",
            request.id(),
            operation,
            child_operation,
            Uuid::new_v4(),
            child,
            &identity
        )
        .is_err());
        tx.commit().unwrap();
        let gate = OwnerCleanup::open(Connection::open(root.path().join("state.sqlite")).unwrap())
            .unwrap();
        assert!(gate
            .delegation_reviewed(
                "owner",
                request.id(),
                child_operation,
                task,
                child,
                &identity
            )
            .unwrap());
        assert!(!gate
            .delegation_reviewed(
                "owner",
                request.id(),
                child_operation,
                task,
                Uuid::new_v4(),
                &identity
            )
            .unwrap());
        assert!(!gate
            .delegation_reviewed(
                "other",
                request.id(),
                child_operation,
                task,
                child,
                &identity
            )
            .unwrap());
        let next = hold(&mut db, "owner", Uuid::new_v4());
        assert!(!gate
            .delegation_reviewed("owner", next.id(), child_operation, task, child, &identity)
            .unwrap());
    }

    #[tokio::test]
    async fn dropped_monitor_waiter_does_not_release_owned_cleanup_before_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let gate =
            Arc::new(OwnerCleanup::open(database(&root.path().join("state.sqlite"))).unwrap());
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let worker = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.run_owned(async move {
                    let _ = entered.send(());
                    let _ = release_rx.await;
                    Ok(())
                })
                .await
            })
        };
        entered_rx.await.unwrap();
        worker.abort();
        let _ = worker.await;
        let mut shutdown = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.shutdown().await })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut shutdown)
                .await
                .is_err()
        );
        let _ = release.send(());
        tokio::time::timeout(Duration::from_secs(2), shutdown)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(gate.run_owned(async { Ok(()) }).await.is_err());
    }

    #[test]
    fn diagnostics_are_scoped_to_the_current_owner_and_request() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut writer = database(&path);
        let first = hold(&mut writer, "owner", Uuid::new_v4());
        let other = hold(&mut writer, "other", Uuid::new_v4());
        let gate = OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap();
        gate.record_issue(
            &first,
            CleanupResource::Delegation,
            Some(CleanupIssue::Unconfirmed),
        )
        .unwrap();
        assert_eq!(
            gate.issues(&first).unwrap(),
            vec![(CleanupResource::Delegation, CleanupIssue::Unconfirmed)]
        );
        assert!(gate.issues(&other).unwrap().is_empty());
        let next = hold(&mut writer, "owner", Uuid::new_v4());
        assert!(gate
            .record_issue(
                &first,
                CleanupResource::Structured,
                Some(CleanupIssue::Unavailable)
            )
            .is_err());
        assert!(gate.issues(&next).unwrap().is_empty());
        gate.record_issue(
            &next,
            CleanupResource::Background,
            Some(CleanupIssue::Unavailable),
        )
        .unwrap();
        gate.record_issue(&next, CleanupResource::Background, None)
            .unwrap();
        assert!(gate.issues(&next).unwrap().is_empty());
    }

    #[tokio::test]
    async fn cleanup_requires_owner_lease_and_exact_acknowledgement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut writer = database(&path);
        let request = hold(&mut writer, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        assert_eq!(
            gate.service(
                "owner",
                || Ok(None),
                || async { Err::<(), String>("unowned cleanup".into()) }
            )
            .await
            .unwrap(),
            None
        );
        let epoch = Uuid::new_v4();
        let receipt = gate
            .service("owner", move || Ok(Some(epoch)), || async { Ok(()) })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt,
            Receipt {
                request: request.clone(),
                lease_epoch: epoch
            }
        );
        assert_eq!(gate.receipt(&request).unwrap(), Some(receipt.clone()));
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        OwnerCleanup::release_in_transaction(&tx, &receipt).unwrap();
        tx.commit().unwrap();
        assert!(!gate.is_held("owner").unwrap());
    }

    #[tokio::test]
    async fn renewed_hold_or_changed_lease_cannot_acknowledge_old_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut writer = database(&path);
        let old = hold(&mut writer, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let epoch = Uuid::new_v4();
        let next = Uuid::new_v4();
        let result = gate
            .service(
                "owner",
                move || Ok(Some(epoch)),
                move || async move {
                    hold(&mut writer, "owner", next);
                    Ok(())
                },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(gate.receipt(&old).unwrap(), None);
        assert_eq!(gate.pending("owner").unwrap().unwrap().id, next);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let result = gate
            .service(
                "owner",
                move || {
                    let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(Some(if n == 0 { epoch } else { Uuid::new_v4() }))
                },
                || async { Ok(()) },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(
            gate.receipt(&Request {
                owner: "owner".into(),
                id: next
            })
            .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn cleanup_failure_keeps_hold_and_other_owners_can_complete() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let a = hold(&mut db, "a", Uuid::new_v4());
        let b = hold(&mut db, "b", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let blocked = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.service(
                    "a",
                    || Ok(Some(Uuid::from_u128(1))),
                    move || async move {
                        let _ = started.send(());
                        let _ = wait.await;
                        Err::<(), String>("cleanup failed".into())
                    },
                )
                .await
            })
        };
        ready.await.unwrap();
        let receipt = gate
            .service("b", || Ok(Some(Uuid::from_u128(2))), || async { Ok(()) })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.request, b);
        release.send(()).unwrap();
        assert!(blocked.await.unwrap().is_err());
        assert_eq!(gate.receipt(&a).unwrap(), None);
        assert!(gate.is_held("a").unwrap());
    }

    #[tokio::test]
    async fn shared_hold_requires_current_structured_and_supervisor_receipts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let old = hold(&mut db, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let supervisor = Uuid::new_v4();
        let outbox = "a".repeat(64);
        gate.record_delegation_receipt("owner", old.id, supervisor, &outbox)
            .unwrap();
        assert!(gate
            .release_after_delegation("owner", old.id, supervisor, &outbox, no_background)
            .is_err());
        gate.service(
            "owner",
            || Ok(Some(Uuid::from_u128(9))),
            || async { Ok(()) },
        )
        .await
        .unwrap()
        .unwrap();
        assert!(gate
            .release_after_delegation("owner", old.id, Uuid::new_v4(), &outbox, no_background)
            .is_err());
        let renewed = hold(&mut db, "owner", Uuid::new_v4());
        assert!(gate
            .release_after_delegation("owner", old.id, supervisor, &outbox, no_background)
            .is_err());
        assert_eq!(gate.receipt(&renewed).unwrap(), None);
        gate.service(
            "owner",
            || Ok(Some(Uuid::from_u128(9))),
            || async { Ok(()) },
        )
        .await
        .unwrap()
        .unwrap();
        gate.record_delegation_receipt("owner", renewed.id, supervisor, &outbox)
            .unwrap();
        db.execute_batch("CREATE TABLE background_ledger_installation(id INTEGER)")
            .unwrap();
        assert!(gate
            .release_after_delegation("owner", renewed.id, supervisor, &outbox, no_background)
            .is_err());
        assert!(gate.is_held("owner").unwrap());
        db.execute_batch("DROP TABLE background_ledger_installation")
            .unwrap();
        gate.release_after_delegation("owner", renewed.id, supervisor, &outbox, no_background)
            .unwrap();
        assert!(!gate.is_held("owner").unwrap());
    }

    #[tokio::test]
    async fn logout_blocks_new_owner_admission_and_waits_for_existing_permit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let active = gate.enter("owner").unwrap();
        let request = hold(&mut db, "owner", Uuid::new_v4());
        assert!(gate.enter("owner").is_err());
        let other = gate.enter("other").unwrap();
        let (entered, observed) = tokio::sync::oneshot::channel();
        let task = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(9))),
                    move || async move {
                        let _ = entered.send(());
                        Ok(())
                    },
                )
                .await
            })
        };
        let early = tokio::time::timeout(Duration::from_millis(100), observed)
            .await
            .is_ok();
        assert!(!early);
        drop(active);
        let receipt = task.await.unwrap().unwrap().unwrap();
        assert_eq!(receipt.request, request);
        assert!(gate.enter("owner").is_err());
        drop(other);
    }

    #[tokio::test]
    async fn concurrent_service_of_same_owner_runs_cleanup_once() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let request = hold(&mut db, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let first = {
            let gate = gate.clone();
            let count = count.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(4))),
                    move || async move {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = started.send(());
                        let _ = wait.await;
                        Ok(())
                    },
                )
                .await
            })
        };
        ready.await.unwrap();
        let (entered, observed) = tokio::sync::oneshot::channel();
        let second = {
            let gate = gate.clone();
            let count = count.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(4))),
                    move || async move {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = entered.send(());
                        Ok(())
                    },
                )
                .await
            })
        };
        let second_entered = tokio::time::timeout(Duration::from_millis(100), observed)
            .await
            .is_ok();
        release.send(()).unwrap();
        let first = first.await.unwrap().unwrap().unwrap();
        let second = second.await.unwrap().unwrap().unwrap();
        assert!(!second_entered);
        assert_eq!(
            (
                first.request,
                second.request,
                count.load(std::sync::atomic::Ordering::SeqCst)
            ),
            (request.clone(), request, 1)
        );
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_release_cleanup_owner_or_duplicate_work() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let request = hold(&mut db, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let first = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(4))),
                    move || async move {
                        let _ = started.send(());
                        let _ = wait.await;
                        Ok(())
                    },
                )
                .await
            })
        };
        ready.await.unwrap();
        first.abort();
        let (entered, observed) = tokio::sync::oneshot::channel();
        let second = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(4))),
                    move || async move {
                        let _ = entered.send(());
                        Ok(())
                    },
                )
                .await
            })
        };
        let duplicate = tokio::time::timeout(Duration::from_millis(100), observed)
            .await
            .is_ok();
        release.send(()).unwrap();
        let receipt = second.await.unwrap().unwrap().unwrap();
        assert!(!duplicate);
        assert_eq!(receipt.request, request);
    }

    #[tokio::test]
    async fn shutdown_waits_for_cleanup_worker_and_rejects_new_workers() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let mut db = database(&path);
        let request = hold(&mut db, "owner", Uuid::new_v4());
        let gate = Arc::new(OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let worker = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.service(
                    "owner",
                    || Ok(Some(Uuid::from_u128(4))),
                    move || async move {
                        let _ = started.send(());
                        let _ = wait.await;
                        Ok(())
                    },
                )
                .await
            })
        };
        ready.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), gate.shutdown())
                .await
                .is_err()
        );
        assert!(gate
            .service(
                "owner",
                || Ok(Some(Uuid::from_u128(4))),
                || async { Ok(()) }
            )
            .await
            .is_err());
        release.send(()).unwrap();
        assert!(worker.await.unwrap().unwrap().is_some());
        tokio::time::timeout(Duration::from_secs(2), gate.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(gate.receipt(&request).unwrap().is_some());
    }

    #[test]
    #[ignore = "invoked by the cross-process acknowledgement test"]
    fn owner_cleanup_child() {
        let Some(path) = std::env::var_os("V4_OWNER_CLEANUP_TEST_DB") else {
            return;
        };
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(std::env::var_os("V4_OWNER_CLEANUP_TEST_LEASE").unwrap())
            .unwrap();
        lease.lock().unwrap();
        let gate = Arc::new(OwnerCleanup::open(Connection::open(path).unwrap()).unwrap());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            gate.service(
                "owner",
                || Ok(Some(Uuid::from_u128(7))),
                || async { Ok(()) },
            )
            .await
            .unwrap()
            .unwrap();
        });
    }

    #[test]
    fn cleanup_acknowledgement_survives_an_owner_process_exit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let lease = root.path().join("lease");
        std::fs::write(&lease, b"lease").unwrap();
        let mut writer = database(&path);
        let request = hold(&mut writer, "owner", Uuid::new_v4());
        let test_module = module_path!().split_once("::").unwrap().1;
        let fixture = format!("{test_module}::owner_cleanup_child");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &fixture, "--ignored"])
            .env("V4_OWNER_CLEANUP_TEST_DB", &path)
            .env("V4_OWNER_CLEANUP_TEST_LEASE", &lease)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Owner cleanup fixture did not exit");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        let gate = OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(
            gate.receipt(&request).unwrap().unwrap().lease_epoch,
            Uuid::from_u128(7)
        );
        assert!(gate.is_held("owner").unwrap());
    }

    #[test]
    #[ignore = "invoked by the cross-process in-flight admission test"]
    fn owner_inflight_child() {
        let Some(path) = std::env::var_os("V4_OWNER_CLEANUP_TEST_DB") else {
            return;
        };
        let ready =
            std::path::PathBuf::from(std::env::var_os("V4_OWNER_CLEANUP_TEST_READY").unwrap());
        let proceed =
            std::path::PathBuf::from(std::env::var_os("V4_OWNER_CLEANUP_TEST_PROCEED").unwrap());
        let release =
            std::path::PathBuf::from(std::env::var_os("V4_OWNER_CLEANUP_TEST_RELEASE").unwrap());
        let scheduled =
            std::path::PathBuf::from(std::env::var_os("V4_OWNER_CLEANUP_TEST_SCHEDULED").unwrap());
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(std::env::var_os("V4_OWNER_CLEANUP_TEST_LEASE").unwrap())
            .unwrap();
        lease.lock().unwrap();
        let gate = Arc::new(OwnerCleanup::open(Connection::open(path).unwrap()).unwrap());
        let active = gate.enter("owner").unwrap();
        std::fs::write(ready, b"ready").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !proceed.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let task = {
                let gate = gate.clone();
                tokio::spawn(async move {
                    gate.service(
                        "owner",
                        || Ok(Some(Uuid::from_u128(19))),
                        || async { Ok(()) },
                    )
                    .await
                })
            };
            std::fs::write(scheduled, b"scheduled").unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while !release.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            drop(active);
            task.await.unwrap().unwrap().unwrap();
        });
    }

    #[test]
    fn cross_process_cleanup_waits_for_admitted_owner_work() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite");
        let lease_path = root.path().join("lease");
        let ready = root.path().join("ready");
        let proceed = root.path().join("proceed");
        let scheduled = root.path().join("scheduled");
        let release = root.path().join("release");
        std::fs::write(&lease_path, b"lease").unwrap();
        let mut writer = database(&path);
        let test_module = module_path!().split_once("::").unwrap().1;
        let fixture = format!("{test_module}::owner_inflight_child");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &fixture, "--ignored"])
            .env("V4_OWNER_CLEANUP_TEST_DB", &path)
            .env("V4_OWNER_CLEANUP_TEST_LEASE", &lease_path)
            .env("V4_OWNER_CLEANUP_TEST_READY", &ready)
            .env("V4_OWNER_CLEANUP_TEST_PROCEED", &proceed)
            .env("V4_OWNER_CLEANUP_TEST_SCHEDULED", &scheduled)
            .env("V4_OWNER_CLEANUP_TEST_RELEASE", &release)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !ready.exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owner process did not enter");
        }
        let request = hold(&mut writer, "owner", Uuid::new_v4());
        let observer = OwnerCleanup::open(Connection::open(&path).unwrap()).unwrap();
        assert!(observer.enter("owner").is_err());
        let lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
            .unwrap();
        assert!(matches!(
            lease.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        std::fs::write(&proceed, b"go").unwrap();
        while !scheduled.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(scheduled.exists());
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(observer.receipt(&request).unwrap(), None);
        std::fs::write(&release, b"release").unwrap();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owner process did not clean up");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        assert_eq!(
            observer.receipt(&request).unwrap().unwrap().lease_epoch,
            Uuid::from_u128(19)
        );
        assert!(observer.is_held("owner").unwrap());
    }
}
