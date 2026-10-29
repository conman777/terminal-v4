use super::*;
use crate::followup_queue::{
    HoldReason, ItemState, Mutation, QueueMode, QueueOperation, QueueScope, QueueSnapshot,
    QueueStore,
};
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex as StdMutex;

type Senders = Arc<StdMutex<Vec<(String, mpsc::UnboundedSender<StructuredSessionEvent>)>>>;

struct Controller(Senders);
#[async_trait]
impl StructuredProcessController for Controller {
    async fn send_input(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn send_approval(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
    async fn kill(&self) -> Result<(), String> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Scripted {
    starts: AtomicUsize,
    senders: Senders,
}
impl StructuredProvider for Scripted {
    fn provider_id(&self) -> &'static str {
        "codex"
    }
    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (sender, events) = mpsc::unbounded_channel();
        self.senders
            .lock()
            .unwrap()
            .push((options.turn_id.unwrap(), sender));
        Ok(SpawnedStructuredProcess {
            controller: Arc::new(Controller(self.senders.clone())),
            events,
        })
    }
}
impl Scripted {
    fn starts(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }
    fn finish(&self, status: &str) {
        let (turn_id, sender) = self.senders.lock().unwrap().remove(0);
        sender
            .send(StructuredSessionEvent::TurnCompleted {
                ts: now_ts(),
                seq: 0,
                turn_id,
                status: status.into(),
            })
            .unwrap();
    }
}

struct Fixture {
    data: tempfile::TempDir,
    workspace: tempfile::TempDir,
    manager: StructuredSessionManager,
    provider: Arc<Scripted>,
    id: String,
}

fn provider() -> Arc<Scripted> {
    Arc::new(Scripted {
        starts: AtomicUsize::new(0),
        senders: Arc::new(StdMutex::new(Vec::new())),
    })
}

fn config(data: &Path) -> AppConfig {
    AppConfig {
        data_dir: data.into(),
        ..Default::default()
    }
}

async fn fixture(guarded: bool) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    if guarded {
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    }
    let provider = provider();
    let manager =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    if guarded {
        manager.bind_live_ownership().unwrap();
    }
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    native_queue::opt_in("owner", &id);
    Fixture {
        data,
        workspace,
        manager,
        provider,
        id,
    }
}

impl Fixture {
    fn scope(&self) -> QueueScope {
        QueueScope::new_native("owner", self.workspace.path(), &self.id).unwrap()
    }
    fn store(&self) -> QueueStore {
        QueueStore::new(self.data.path(), queue::manager_boot_id(&self.manager))
    }
    fn enqueue(&self, text: &str) -> Uuid {
        let store = self.store();
        let revision = store.load(&self.scope()).unwrap().revision;
        let item_id = Uuid::new_v4();
        store
            .mutate(
                &self.scope(),
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: revision,
                    operation: QueueOperation::Enqueue {
                        item_id,
                        text: text.into(),
                        run_when_idle: true,
                    },
                },
            )
            .unwrap();
        item_id
    }
    fn on_disk(&self) -> QueueSnapshot {
        self.store().inspect(&self.scope()).unwrap().unwrap()
    }
    fn queue_path(&self) -> PathBuf {
        use sha2::{Digest, Sha256};
        let hash = |value: &str| hex::encode(Sha256::digest(value.as_bytes()));
        self.data
            .path()
            .join("followup-queues")
            .join(hash("owner"))
            .join(hash(
                self.workspace
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            ))
            .join(format!("{}.json", self.id))
    }
    async fn start_turn(&self) {
        self.manager
            .submit(
                "owner",
                &self.id,
                "first turn",
                Some(&Uuid::new_v4().to_string()),
            )
            .await
            .unwrap();
    }
    fn journal(&self) -> Vec<StructuredSessionEvent> {
        storage::read_for_recovery(&config(self.data.path()), "owner", &self.id)
            .unwrap()
            .snapshot
            .events
    }
    fn accepted_requests(&self) -> Vec<String> {
        self.journal()
            .into_iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::UserMessageAccepted { request_id, .. } => Some(request_id),
                _ => None,
            })
            .collect()
    }
}

async fn eventually(mut condition: impl FnMut() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("condition was not reached");
}

async fn idle(fx: &Fixture) {
    for _ in 0..500 {
        let session = fx
            .manager
            .owned_session("owner", &fx.id)
            .await
            .unwrap()
            .unwrap();
        if session.state.lock().await.process.is_none() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("session did not become idle");
}

#[tokio::test]
async fn sessions_without_runtime_opt_in_have_no_native_queue() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let manager =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider()]);
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some("codex"),
            None,
            None,
        )
        .await
        .unwrap()
        .id;
    assert!(manager.queue_snapshot("owner", &id).await.is_err());
    queue::hold_session(&manager, "owner", &id).await.unwrap();
    assert!(!data.path().join("followup-queues").exists());
}

#[tokio::test]
async fn clean_idle_boundary_dispatches_the_next_item_with_its_durable_request_id() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    let item = fx.enqueue("second turn");
    fx.provider.finish("completed");
    eventually(|| fx.provider.starts() == 2).await;
    eventually(|| fx.on_disk().items[0].state == ItemState::Accepted).await;
    let queue = fx.on_disk();
    let request_id = queue.items[0].input_request_id;
    assert_eq!(
        (
            queue.items[0].item_id,
            queue.items[0]
                .accepted_receipt
                .as_ref()
                .map(|r| r.request_id)
        ),
        (item, Some(request_id))
    );
    assert!(fx.accepted_requests().contains(&request_id.to_string()));
    assert_eq!(fx.accepted_requests().len(), 2);
}

#[tokio::test]
async fn interrupted_or_failed_turns_hold_the_queue_on_disk() {
    for status in ["interrupted", "failed"] {
        let fx = fixture(false).await;
        fx.start_turn().await;
        let item = fx.enqueue("must wait");
        fx.provider.finish(status);
        eventually(|| fx.on_disk().mode == QueueMode::Held).await;
        let queue = fx.on_disk();
        assert_eq!(
            (
                queue.hold_reason,
                queue.items[0].item_id,
                queue.items[0].state
            ),
            (Some(HoldReason::Manual), item, ItemState::Pending)
        );
        assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (1, 1));
    }
}

#[tokio::test]
async fn pending_approval_blocks_the_drain_without_answering_it() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.enqueue("after approval");
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    let before = {
        let mut state = session.state.lock().await;
        let turn_id = fx.journal().iter().find_map(|event| match event {
            StructuredSessionEvent::UserMessageAccepted { turn_id, .. } => Some(turn_id.clone()),
            _ => None,
        });
        let event = StructuredSessionEvent::ApprovalDecisionStarted {
            ts: now_ts(),
            seq: next_session_seq(&state.events).unwrap(),
            approval_id: Uuid::new_v4().to_string(),
            turn_id: turn_id.unwrap(),
            approved: true,
            for_session: false,
        };
        fx.manager.persist_event(&mut state, &event, true).unwrap();
        state.generation
    };
    fx.provider.finish("completed");
    idle(&fx).await;
    queue::drain(fx.manager.clone(), "owner".into(), fx.id.clone(), before)
        .await
        .unwrap();
    let queue = fx.on_disk();
    assert_eq!(
        (queue.mode, queue.items[0].state, fx.provider.starts()),
        (QueueMode::Running, ItemState::Pending, 1)
    );
}

#[tokio::test]
async fn workspace_activity_fence_defers_the_drain_until_released() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.provider.finish("completed");
    idle(&fx).await;
    let fence = loop {
        match crate::workspace_activity::exclusive(fx.workspace.path()) {
            Ok(fence) => break fence,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
        }
    };
    fx.enqueue("after rewind");
    let generation = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap()
        .state
        .lock()
        .await
        .generation;
    let before = fx.on_disk();
    queue::drain(
        fx.manager.clone(),
        "owner".into(),
        fx.id.clone(),
        generation,
    )
    .await
    .unwrap();
    assert_eq!((fx.on_disk(), fx.provider.starts()), (before, 1));
    drop(fence);
    queue::drain(
        fx.manager.clone(),
        "owner".into(),
        fx.id.clone(),
        generation,
    )
    .await
    .unwrap();
    eventually(|| fx.provider.starts() == 2).await;
}

#[tokio::test]
async fn missing_incarnation_holds_the_queue_and_is_never_recreated() {
    let fx = fixture(false).await;
    fx.enqueue("needs identity");
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    let generation = {
        let mut state = session.state.lock().await;
        state.session_incarnation = None;
        state.generation
    };
    queue::drain(
        fx.manager.clone(),
        "owner".into(),
        fx.id.clone(),
        generation,
    )
    .await
    .unwrap();
    let queue = fx.on_disk();
    assert_eq!(
        (
            queue.mode,
            queue.hold_reason,
            queue.items[0].state,
            fx.provider.starts()
        ),
        (
            QueueMode::Held,
            Some(HoldReason::Manual),
            ItemState::Pending,
            0
        )
    );
    assert!(session.state.lock().await.session_incarnation.is_none());
}

#[tokio::test]
async fn direct_send_is_fenced_by_a_running_queue() {
    let fx = fixture(false).await;
    fx.enqueue("queued first");
    let result = fx
        .manager
        .submit("owner", &fx.id, "direct", Some(&Uuid::new_v4().to_string()))
        .await;
    assert_eq!(result.unwrap_err().code, "conflict");
    assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (0, 0));
}

#[tokio::test]
async fn crash_after_reservation_without_acceptance_is_held_and_never_replayed() {
    let fx = fixture(false).await;
    let item = fx.enqueue("reserved then crashed");
    let store = fx.store();
    let revision = store.load(&fx.scope()).unwrap().revision;
    store
        .reserve_next(
            &fx.scope(),
            revision,
            crate::followup_queue::IdleBoundary { turn_epoch: 0 },
        )
        .unwrap()
        .unwrap();
    let Fixture {
        data,
        workspace,
        manager,
        id,
        ..
    } = fx;
    drop(manager);
    let provider = provider();
    let restarted =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    native_queue::opt_in("owner", &id);
    let snapshot = restarted.queue_snapshot("owner", &id).await.unwrap();
    assert_eq!(
        (
            snapshot.mode,
            snapshot.hold_reason,
            snapshot.items[0].item_id,
            snapshot.items[0].state
        ),
        (
            QueueMode::Held,
            Some(HoldReason::DispatchError),
            item,
            ItemState::Pending
        )
    );
    let scope = QueueScope::new_native("owner", workspace.path(), &id).unwrap();
    let on_disk = QueueStore::new(data.path(), Uuid::new_v4())
        .inspect(&scope)
        .unwrap()
        .unwrap();
    assert_eq!(on_disk.items[0].state, ItemState::Pending);
    assert_eq!(provider.starts(), 0);
}

#[tokio::test]
async fn crash_after_acceptance_reconciles_to_accepted_without_a_second_start() {
    let fx = fixture(false).await;
    fx.enqueue("accepted then crashed");
    let store = fx.store();
    let revision = store.load(&fx.scope()).unwrap().revision;
    let reservation = store
        .reserve_next(
            &fx.scope(),
            revision,
            crate::followup_queue::IdleBoundary { turn_epoch: 0 },
        )
        .unwrap()
        .unwrap();
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    {
        let mut state = session.state.lock().await;
        let event = StructuredSessionEvent::UserMessageAccepted {
            ts: now_ts(),
            seq: next_session_seq(&state.events).unwrap(),
            request_id: reservation.input_request_id.to_string(),
            turn_id: Uuid::new_v4().to_string(),
            message_id: Uuid::new_v4().to_string(),
            content: "accepted then crashed".into(),
            attachments: vec![],
        };
        fx.manager.persist_event(&mut state, &event, true).unwrap();
    }
    let Fixture {
        data,
        workspace,
        manager,
        id,
        ..
    } = fx;
    drop(session);
    drop(manager);
    let provider = provider();
    let restarted =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    native_queue::opt_in("owner", &id);
    let snapshot = restarted.queue_snapshot("owner", &id).await.unwrap();
    assert_eq!(snapshot.items[0].state, ItemState::Accepted);
    assert_eq!(
        snapshot.items[0]
            .accepted_receipt
            .as_ref()
            .map(|r| r.request_id),
        Some(reservation.input_request_id)
    );
    let again = restarted.queue_snapshot("owner", &id).await.unwrap();
    assert_eq!(again.items, snapshot.items);
    let scope = QueueScope::new_native("owner", workspace.path(), &id).unwrap();
    let on_disk = QueueStore::new(data.path(), Uuid::new_v4())
        .inspect(&scope)
        .unwrap()
        .unwrap();
    assert_eq!(on_disk.items[0].state, ItemState::Accepted);
    assert_eq!(provider.starts(), 0);
}

#[tokio::test]
async fn uncertain_commit_with_a_live_process_stays_dispatching_and_held() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.enqueue("uncertain");
    let store = fx.store();
    let revision = store.load(&fx.scope()).unwrap().revision;
    let reservation = store
        .reserve_next(
            &fx.scope(),
            revision,
            crate::followup_queue::IdleBoundary { turn_epoch: 0 },
        )
        .unwrap()
        .unwrap();
    let snapshot = fx.manager.queue_snapshot("owner", &fx.id).await.unwrap();
    assert_eq!(
        (snapshot.mode, snapshot.hold_reason, snapshot.items[0].state),
        (
            QueueMode::Held,
            Some(HoldReason::DispatchError),
            ItemState::Dispatching
        )
    );
    let on_disk = fx.on_disk();
    assert_eq!(
        (on_disk.items[0].state, on_disk.items[0].input_request_id),
        (ItemState::Dispatching, reservation.input_request_id)
    );
    assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (1, 1));
}

#[tokio::test]
async fn damaged_queue_record_is_preserved_and_never_dispatches() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.enqueue("will be damaged");
    let path = fx.queue_path();
    std::fs::write(&path, b"{not a queue").unwrap();
    fx.provider.finish("completed");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(std::fs::read(&path).unwrap(), b"{not a queue");
    assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (1, 1));
    assert!(fx.manager.queue_snapshot("owner", &fx.id).await.is_err());
}

#[tokio::test]
async fn stop_holds_the_native_queue_and_the_finished_turn_does_not_drain() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.enqueue("held by stop");
    fx.manager.interrupt("owner", &fx.id).await.unwrap();
    let queue = fx.on_disk();
    assert_eq!(
        (queue.mode, queue.hold_reason, queue.items[0].state),
        (
            QueueMode::Held,
            Some(HoldReason::Manual),
            ItemState::Pending
        )
    );
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (1, 1));
    assert_eq!(fx.on_disk().mode, QueueMode::Held);
}

#[tokio::test]
async fn delete_holds_the_native_queue_and_removes_lease_files() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    fx.provider.finish("completed");
    idle(&fx).await;
    fx.enqueue("orphaned");
    let config = config(fx.data.path());
    let lease = request_ledger::session_file(
        &config,
        "structured-session-leases",
        "owner",
        &fx.id,
        "lock",
    )
    .unwrap();
    assert!(lease.exists());
    fx.manager.delete_session("owner", &fx.id).await.unwrap();
    assert!(!lease.exists());
    let queue = fx.on_disk();
    assert_eq!(
        (queue.mode, queue.hold_reason, queue.items[0].state),
        (
            QueueMode::Held,
            Some(HoldReason::Manual),
            ItemState::Pending
        )
    );
}

#[tokio::test]
async fn signed_authority_dispatches_once_and_logout_revokes_a_queued_item() {
    for logout in [false, true] {
        let fx = fixture(true).await;
        let app = crate::state::AppState::new_with_services(
            config(fx.data.path()),
            None,
            fx.manager.clone(),
        )
        .unwrap();
        fx.manager
            .bind_local_admission(app.local_admission().unwrap())
            .unwrap();
        crate::vault::VaultCipher::load(fx.data.path()).unwrap();
        let incarnation = fx
            .manager
            .session_incarnation_for_test("owner", &fx.id)
            .await
            .unwrap();
        fx.start_turn().await;
        let authority = crate::auth::LocalAuthority::for_test(
            "owner",
            0,
            crate::v4_agent::interaction::now_ms() + 60_000,
        );
        let store = fx.store();
        let revision = store.load(&fx.scope()).unwrap().revision;
        store
            .mutate_authorized(
                &fx.scope(),
                incarnation,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: revision,
                    operation: QueueOperation::Enqueue {
                        item_id: Uuid::new_v4(),
                        text: "signed work".into(),
                        run_when_idle: true,
                    },
                },
                &authority,
            )
            .unwrap();
        if logout {
            app.logout_user("owner").unwrap();
        }
        fx.provider.finish("completed");
        if logout {
            eventually(|| fx.on_disk().mode == QueueMode::Held).await;
            let queue = fx.on_disk();
            assert_eq!(queue.hold_reason, Some(HoldReason::DispatchError));
            assert_eq!(
                (
                    queue.mode,
                    queue.items[0].state,
                    fx.provider.starts(),
                    fx.accepted_requests().len()
                ),
                (QueueMode::Held, ItemState::Pending, 1, 1)
            );
        } else {
            eventually(|| fx.provider.starts() == 2).await;
            eventually(|| fx.on_disk().items[0].state == ItemState::Accepted).await;
            assert_eq!(fx.accepted_requests().len(), 2);
        }
    }
}
