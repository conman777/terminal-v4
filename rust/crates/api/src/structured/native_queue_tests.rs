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
    id: &'static str,
    starts: AtomicUsize,
    senders: Senders,
}
impl StructuredProvider for Scripted {
    fn provider_id(&self) -> &'static str {
        self.id
    }
    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (sender, events) = mpsc::unbounded_channel();
        self.senders
            .lock()
            .unwrap()
            .push((options.turn_id.unwrap_or_default(), sender));
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
        let event = if self.id == "claude" {
            StructuredSessionEvent::SessionEnded {
                ts: now_ts(),
                seq: 0,
                session_id: "claude-session".into(),
                reason: status.into(),
            }
        } else {
            StructuredSessionEvent::TurnCompleted {
                ts: now_ts(),
                seq: 0,
                turn_id,
                status: status.into(),
            }
        };
        sender.send(event).unwrap();
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
    provider_for("codex")
}

fn provider_for(id: &'static str) -> Arc<Scripted> {
    Arc::new(Scripted {
        id,
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
    fixture_for(guarded, "codex").await
}

async fn fixture_for(guarded: bool, provider_id: &'static str) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    if guarded {
        rusqlite::Connection::open(data.path().join("terminal.db")).unwrap();
    }
    let provider = provider_for(provider_id);
    let manager =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    if guarded {
        manager.bind_live_ownership().unwrap();
    }
    let id = manager
        .create_session(
            "owner",
            workspace.path().to_str().unwrap(),
            Some(provider_id),
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
                StructuredSessionEvent::MessageCompleted {
                    role, message_id, ..
                } if role == "user" => message_id,
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

async fn signed_authority_scenario(provider_id: &'static str) {
    for logout in [false, true] {
        let fx = fixture_for(true, provider_id).await;
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

#[tokio::test]
async fn signed_authority_dispatches_once_and_logout_revokes_a_queued_item() {
    signed_authority_scenario("codex").await;
}

#[tokio::test]
async fn claude_signed_authority_dispatches_once_and_logout_revokes_a_queued_item() {
    signed_authority_scenario("claude").await;
}

async fn fenced_by_approval(fx: &Fixture) -> (String, String) {
    fx.start_turn().await;
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    let turn_id = fx
        .journal()
        .iter()
        .find_map(|event| match event {
            StructuredSessionEvent::UserMessageAccepted { turn_id, .. } => Some(turn_id.clone()),
            _ => None,
        })
        .unwrap();
    let approval_id = Uuid::new_v4().to_string();
    let mut state = session.state.lock().await;
    let event = StructuredSessionEvent::ApprovalDecisionStarted {
        ts: now_ts(),
        seq: next_session_seq(&state.events).unwrap(),
        approval_id: approval_id.clone(),
        turn_id: turn_id.clone(),
        approved: true,
        for_session: false,
    };
    fx.manager.persist_event(&mut state, &event, true).unwrap();
    (approval_id, turn_id)
}

async fn resolve_approval(fx: &Fixture, approval_id: &str, turn_id: &str, persist: bool) {
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    let mut state = session.state.lock().await;
    let event = StructuredSessionEvent::ApprovalResolved {
        ts: now_ts(),
        seq: next_session_seq(&state.events).unwrap(),
        approval_id: approval_id.into(),
        turn_id: turn_id.into(),
        approved: false,
        reason: Some("resolved by test".into()),
    };
    if persist {
        fx.manager.persist_event(&mut state, &event, true).unwrap();
    } else {
        state.events.push(event);
    }
}

#[tokio::test]
async fn approval_fence_skip_is_rescheduled_by_the_resolution_event() {
    let fx = fixture(false).await;
    let (approval_id, turn_id) = fenced_by_approval(&fx).await;
    fx.enqueue("after approval");
    fx.provider.finish("completed");
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        (fx.provider.starts(), fx.on_disk().items[0].state),
        (1, ItemState::Pending)
    );
    resolve_approval(&fx, &approval_id, &turn_id, true).await;
    eventually(|| fx.provider.starts() == 2).await;
    eventually(|| fx.on_disk().items[0].state == ItemState::Accepted).await;
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 0).await;
    assert_eq!(fx.accepted_requests().len(), 2);
}

#[tokio::test]
async fn repeated_skipped_drains_share_one_retry_task() {
    let fx = fixture(false).await;
    let _fence = fenced_by_approval(&fx).await;
    fx.enqueue("held back");
    fx.provider.finish("completed");
    idle(&fx).await;
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
    for _ in 0..3 {
        queue::drain(
            fx.manager.clone(),
            "owner".into(),
            fx.id.clone(),
            generation,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        (
            native_queue::retrying_for_test(fx.data.path()),
            fx.provider.starts()
        ),
        (1, 1)
    );
}

#[tokio::test]
async fn bounded_fallback_timer_recovers_a_missed_approval_wakeup() {
    native_queue::set_fallback_for_test(std::time::Duration::from_millis(40));
    let fx = fixture(false).await;
    let (approval_id, turn_id) = fenced_by_approval(&fx).await;
    fx.enqueue("after silent resolution");
    fx.provider.finish("completed");
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 1).await;
    resolve_approval(&fx, &approval_id, &turn_id, false).await;
    eventually(|| fx.provider.starts() == 2).await;
    native_queue::set_fallback_for_test(std::time::Duration::from_secs(60));
}

#[tokio::test]
async fn workspace_writer_release_reschedules_the_skipped_drain() {
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
    queue::drain(
        fx.manager.clone(),
        "owner".into(),
        fx.id.clone(),
        generation,
    )
    .await
    .unwrap();
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(fx.provider.starts(), 1);
    drop(fence);
    eventually(|| fx.provider.starts() == 2).await;
}

#[tokio::test]
async fn a_hold_taken_while_fenced_is_never_drained_when_the_fence_clears() {
    native_queue::set_fallback_for_test(std::time::Duration::from_millis(40));
    let fx = fixture(false).await;
    let (approval_id, turn_id) = fenced_by_approval(&fx).await;
    fx.enqueue("held while fenced");
    fx.provider.finish("completed");
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 1).await;
    queue::hold_session(&fx.manager, "owner", &fx.id)
        .await
        .unwrap();
    resolve_approval(&fx, &approval_id, &turn_id, true).await;
    eventually(|| native_queue::retrying_for_test(fx.data.path()) == 0).await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
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
            1
        )
    );
    native_queue::set_fallback_for_test(std::time::Duration::from_secs(60));
}

fn claude_intent(fx_data: &Path, id: &str, request_id: Uuid, message_id: &str, text: &str) {
    request_ledger::record_intent(
        &config(fx_data),
        "owner",
        id,
        &request_ledger::IntentRecord {
            request_id: request_id.to_string(),
            message_id: message_id.into(),
            text_sha256: request_ledger::text_digest(&normalize_structured_input_message(text)),
        },
    )
    .unwrap();
}

async fn reserve(fx: &Fixture) -> crate::followup_queue::DispatchReservation {
    let store = fx.store();
    let revision = store.load(&fx.scope()).unwrap().revision;
    store
        .reserve_next(
            &fx.scope(),
            revision,
            crate::followup_queue::IdleBoundary { turn_epoch: 0 },
        )
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn claude_clean_completion_drains_with_the_ledger_receipt() {
    let fx = fixture_for(false, "claude").await;
    fx.start_turn().await;
    let item = fx.enqueue("second claude turn");
    fx.provider.finish("completed");
    eventually(|| fx.provider.starts() == 2).await;
    eventually(|| fx.on_disk().items[0].state == ItemState::Accepted).await;
    let queue = fx.on_disk();
    let request_id = queue.items[0].input_request_id;
    let receipt = queue.items[0].accepted_receipt.clone().unwrap();
    let intent = request_ledger::find_intent(
        &config(fx.data.path()),
        "owner",
        &fx.id,
        &request_id.to_string(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            queue.items[0].item_id,
            receipt.request_id,
            receipt.message_id,
            fx.accepted_requests().len()
        ),
        (item, request_id, intent.message_id, 2)
    );
}

#[tokio::test]
async fn claude_interrupted_failed_or_errored_turns_hold_the_queue() {
    for reason in ["interrupted", "error"] {
        let fx = fixture_for(false, "claude").await;
        fx.start_turn().await;
        fx.enqueue("must not run");
        fx.provider.finish(reason);
        eventually(|| fx.on_disk().mode == QueueMode::Held).await;
        let queue = fx.on_disk();
        assert_eq!(
            (
                queue.hold_reason,
                queue.items[0].state,
                fx.provider.starts()
            ),
            (Some(HoldReason::Manual), ItemState::Pending, 1)
        );
    }
}

#[tokio::test]
async fn claude_error_event_before_a_completed_end_still_holds_the_queue() {
    let fx = fixture_for(false, "claude").await;
    fx.start_turn().await;
    fx.enqueue("must not run");
    let (_, sender) = fx.provider.senders.lock().unwrap().remove(0);
    sender
        .send(StructuredSessionEvent::Error {
            ts: now_ts(),
            seq: 0,
            message: "result reported an error".into(),
            code: None,
        })
        .unwrap();
    sender
        .send(StructuredSessionEvent::SessionEnded {
            ts: now_ts(),
            seq: 0,
            session_id: "claude-session".into(),
            reason: "completed".into(),
        })
        .unwrap();
    drop(sender);
    eventually(|| fx.on_disk().mode == QueueMode::Held).await;
    assert_eq!(
        (fx.on_disk().hold_reason, fx.provider.starts()),
        (Some(HoldReason::Manual), 1)
    );
}

#[tokio::test]
async fn claude_stream_that_ends_without_a_session_end_holds_the_queue() {
    let fx = fixture_for(false, "claude").await;
    fx.start_turn().await;
    fx.enqueue("must not run");
    fx.provider.senders.lock().unwrap().clear();
    eventually(|| fx.on_disk().mode == QueueMode::Held).await;
    assert_eq!(fx.provider.starts(), 1);
}

#[tokio::test]
async fn claude_crash_with_ledger_intent_but_no_message_is_absent_held_and_not_replayed() {
    let fx = fixture_for(false, "claude").await;
    let item = fx.enqueue("intent only");
    let reservation = reserve(&fx).await;
    claude_intent(
        fx.data.path(),
        &fx.id,
        reservation.input_request_id,
        &Uuid::new_v4().to_string(),
        "intent only",
    );
    let Fixture {
        data, manager, id, ..
    } = fx;
    drop(manager);
    let provider = provider_for("claude");
    let restarted =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    native_queue::opt_in("owner", &id);
    let snapshot = restarted.queue_snapshot("owner", &id).await.unwrap();
    assert_eq!(
        (
            snapshot.mode,
            snapshot.hold_reason,
            snapshot.items[0].item_id,
            snapshot.items[0].state,
            provider.starts()
        ),
        (
            QueueMode::Held,
            Some(HoldReason::DispatchError),
            item,
            ItemState::Pending,
            0
        )
    );
}

#[tokio::test]
async fn claude_crash_after_the_message_was_journaled_reconciles_to_accepted() {
    let fx = fixture_for(false, "claude").await;
    fx.enqueue("journaled then crashed");
    let reservation = reserve(&fx).await;
    let message_id = Uuid::new_v4().to_string();
    claude_intent(
        fx.data.path(),
        &fx.id,
        reservation.input_request_id,
        &message_id,
        "journaled then crashed",
    );
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    {
        let mut state = session.state.lock().await;
        let event = StructuredSessionEvent::MessageCompleted {
            ts: now_ts(),
            seq: next_session_seq(&state.events).unwrap(),
            message_id: Some(message_id.clone()),
            turn_id: None,
            role: "user".into(),
            content: "journaled then crashed".into(),
        };
        fx.manager.persist_event(&mut state, &event, true).unwrap();
    }
    let Fixture {
        data, manager, id, ..
    } = fx;
    drop(session);
    drop(manager);
    let provider = provider_for("claude");
    let restarted =
        StructuredSessionManager::new_with_providers(config(data.path()), vec![provider.clone()]);
    native_queue::opt_in("owner", &id);
    let snapshot = restarted.queue_snapshot("owner", &id).await.unwrap();
    let receipt = snapshot.items[0].accepted_receipt.clone().unwrap();
    assert_eq!(
        (
            snapshot.items[0].state,
            receipt.request_id,
            receipt.message_id,
            provider.starts()
        ),
        (
            ItemState::Accepted,
            reservation.input_request_id,
            message_id,
            0
        )
    );
}

#[tokio::test]
async fn claude_journaled_message_with_different_text_holds_for_review() {
    let fx = fixture_for(false, "claude").await;
    fx.enqueue("original text");
    let reservation = reserve(&fx).await;
    let message_id = Uuid::new_v4().to_string();
    claude_intent(
        fx.data.path(),
        &fx.id,
        reservation.input_request_id,
        &message_id,
        "original text",
    );
    let session = fx
        .manager
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .unwrap();
    {
        let mut state = session.state.lock().await;
        let event = StructuredSessionEvent::MessageCompleted {
            ts: now_ts(),
            seq: next_session_seq(&state.events).unwrap(),
            message_id: Some(message_id),
            turn_id: None,
            role: "user".into(),
            content: "something else".into(),
        };
        fx.manager.persist_event(&mut state, &event, true).unwrap();
    }
    assert!(fx.manager.queue_snapshot("owner", &fx.id).await.is_err());
    let queue = fx.on_disk();
    assert_eq!(
        (queue.mode, queue.hold_reason, queue.items[0].state),
        (
            QueueMode::Held,
            Some(HoldReason::DispatchError),
            ItemState::Dispatching
        )
    );
}

#[tokio::test]
async fn claude_stop_direct_send_and_delete_respect_the_native_queue() {
    let fx = fixture_for(false, "claude").await;
    fx.enqueue("queued first");
    let direct = fx
        .manager
        .submit("owner", &fx.id, "direct", Some(&Uuid::new_v4().to_string()))
        .await;
    assert_eq!(direct.unwrap_err().code, "conflict");
    assert_eq!((fx.provider.starts(), fx.accepted_requests().len()), (0, 0));
    fx.manager.interrupt("owner", &fx.id).await.unwrap();
    assert_eq!(
        (fx.on_disk().mode, fx.on_disk().hold_reason),
        (QueueMode::Held, Some(HoldReason::Manual))
    );
    fx.manager.delete_session("owner", &fx.id).await.unwrap();
    assert_eq!(fx.on_disk().items[0].state, ItemState::Pending);
    assert_eq!(fx.on_disk().mode, QueueMode::Held);
}

#[tokio::test]
async fn provider_callback_from_a_stale_manager_fails_closed_without_touching_the_journal() {
    let fx = fixture(false).await;
    fx.start_turn().await;
    let other = StructuredSessionManager::new_with_providers(
        config(fx.data.path()),
        vec![provider_for("codex")],
    );
    assert!(other
        .owned_session("owner", &fx.id)
        .await
        .unwrap()
        .is_some());
    let before = fx.journal();
    let result = fx
        .manager
        .record_event(
            "owner",
            &fx.id,
            StructuredSessionEvent::MessageCompleted {
                ts: now_ts(),
                seq: 0,
                message_id: Some(Uuid::new_v4().to_string()),
                turn_id: None,
                role: "assistant".into(),
                content: "late callback".into(),
            },
        )
        .await;
    assert_eq!((result.is_err(), fx.journal()), (true, before));
}

async fn guarded_app(fx: &Fixture) -> crate::state::AppState {
    let app =
        crate::state::AppState::new_with_services(config(fx.data.path()), None, fx.manager.clone())
            .unwrap();
    fx.manager
        .bind_local_admission(app.local_admission().unwrap())
        .unwrap();
    crate::vault::VaultCipher::load(fx.data.path()).unwrap();
    app
}

async fn owner_cleanup_scenario(provider_id: &'static str) {
    let fx = fixture_for(true, provider_id).await;
    let app =
        crate::state::AppState::new_with_services(config(fx.data.path()), None, fx.manager.clone())
            .unwrap();
    let cleanup = app.provision_owner_cleanup().unwrap();
    fx.manager.bind_owner_cleanup(cleanup.clone()).unwrap();
    fx.start_turn().await;
    let item = fx.enqueue("pending at logout");
    let hold = {
        let mut db = app.lock_db().unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let hold =
            owner_cleanup::OwnerCleanup::hold_in_transaction(&tx, "owner", Uuid::new_v4()).unwrap();
        tx.commit().unwrap();
        hold
    };
    assert!(fx
        .manager
        .service_owner_cleanup("owner")
        .await
        .unwrap()
        .is_some());
    assert!(cleanup.receipt(&hold).unwrap().is_some());
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let queue = fx.on_disk();
    assert_eq!(
        (
            queue.mode,
            queue.hold_reason,
            queue.items[0].item_id,
            queue.items[0].state,
            fx.provider.starts(),
            fx.accepted_requests().len()
        ),
        (
            QueueMode::Held,
            Some(HoldReason::Manual),
            item,
            ItemState::Pending,
            1,
            1
        )
    );
}

#[tokio::test]
async fn owner_cleanup_after_logout_holds_a_codex_queue() {
    owner_cleanup_scenario("codex").await;
}

#[tokio::test]
async fn owner_cleanup_after_logout_holds_a_claude_queue() {
    owner_cleanup_scenario("claude").await;
}

#[tokio::test]
async fn graceful_shutdown_keeps_native_queue_pending_and_held_for_the_next_process() {
    for provider_id in ["codex", "claude"] {
        let fx = fixture_for(false, provider_id).await;
        fx.start_turn().await;
        fx.enqueue("survives shutdown");
        fx.manager.shutdown().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
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
                1
            )
        );
        let Fixture {
            data,
            manager,
            id,
            workspace,
            ..
        } = fx;
        drop(manager);
        let provider = provider_for(provider_id);
        let restarted = StructuredSessionManager::new_with_providers(
            config(data.path()),
            vec![provider.clone()],
        );
        native_queue::opt_in("owner", &id);
        let snapshot = restarted.queue_snapshot("owner", &id).await.unwrap();
        let _ = workspace;
        assert_eq!(
            (snapshot.mode, snapshot.items[0].state, provider.starts()),
            (QueueMode::Held, ItemState::Pending, 0)
        );
    }
}

#[tokio::test]
async fn native_sessions_cannot_be_settled_so_a_queue_is_never_settled_away() {
    for provider_id in ["codex", "claude"] {
        let fx = fixture_for(false, provider_id).await;
        fx.enqueue("pending");
        let result = fx
            .manager
            .update_thread(
                "owner",
                &fx.id,
                StructuredThreadUpdate {
                    settled: Some(true),
                    ..Default::default()
                },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(fx.on_disk().items[0].state, ItemState::Pending);
    }
}

async fn unproven_item_scenario(provider_id: &'static str) {
    let fx = fixture_for(true, provider_id).await;
    let _app = guarded_app(&fx).await;
    fx.start_turn().await;
    fx.enqueue("no durable proof");
    fx.provider.finish("completed");
    eventually(|| fx.on_disk().mode == QueueMode::Held).await;
    let queue = fx.on_disk();
    assert_eq!(
        (
            queue.hold_reason,
            queue.items[0].state,
            fx.provider.starts(),
            fx.accepted_requests().len()
        ),
        (Some(HoldReason::DispatchError), ItemState::Pending, 1, 1)
    );
}

#[tokio::test]
async fn unproven_codex_item_is_held_for_reauthorization_not_dispatched() {
    unproven_item_scenario("codex").await;
}

#[tokio::test]
async fn unproven_claude_item_is_held_for_reauthorization_not_dispatched() {
    unproven_item_scenario("claude").await;
}

async fn foreign_incarnation_scenario(provider_id: &'static str) {
    let fx = fixture_for(true, provider_id).await;
    let _app = guarded_app(&fx).await;
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
            Uuid::new_v4(),
            Mutation {
                operation_id: Uuid::new_v4(),
                expected_queue_revision: revision,
                operation: QueueOperation::Enqueue {
                    item_id: Uuid::new_v4(),
                    text: "signed for another conversation".into(),
                    run_when_idle: true,
                },
            },
            &authority,
        )
        .unwrap();
    fx.provider.finish("completed");
    eventually(|| fx.on_disk().mode == QueueMode::Held).await;
    assert_eq!(
        (fx.on_disk().items[0].state, fx.provider.starts()),
        (ItemState::Pending, 1)
    );
}

#[tokio::test]
async fn codex_proof_for_another_incarnation_is_refused_and_held() {
    foreign_incarnation_scenario("codex").await;
}

#[tokio::test]
async fn claude_proof_for_another_incarnation_is_refused_and_held() {
    foreign_incarnation_scenario("claude").await;
}
