use std::collections::HashMap;
use terminal_v4_core::{StructuredSessionEvent, StructuredSettlement, StructuredSnooze};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadLifecycle {
    supported: bool,
    snoozed: bool,
    pub(super) requires_attention: bool,
    settlement_supported: bool,
    settled: bool,
    pub(super) can_settle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snoozed_until_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    settlement_unavailable_reason: Option<&'static str>,
}

pub(super) fn project(
    events: &[StructuredSessionEvent],
    snooze: Option<&StructuredSnooze>,
    status: Option<&str>,
    now_ms: i64,
    browser_pending: bool,
) -> ThreadLifecycle {
    let requires_attention = browser_pending
        || has_pending_request(events)
        || !matches!(
            status,
            Some("idle" | "accepted" | "running" | "completed" | "cancelled")
        );
    let active = snooze.filter(|snooze| {
        snooze.until_ms > now_ms && !requires_attention && !woke_after(events, snooze.after_seq)
    });
    ThreadLifecycle {
        supported: true,
        snoozed: active.is_some(),
        requires_attention,
        settlement_supported: false,
        settled: false,
        can_settle: false,
        snoozed_until_ms: active.map(|snooze| snooze.until_ms),
        settlement_unavailable_reason: None,
    }
}

impl ThreadLifecycle {
    pub(super) fn with_settlement(
        mut self,
        settlement: Option<&StructuredSettlement>,
        queue: Option<(String, bool)>,
        process_active: bool,
        archived: bool,
        status: Option<&str>,
        events: &[StructuredSessionEvent],
    ) -> Self {
        self.settlement_supported = queue.is_some();
        let Some((fingerprint, pending)) = queue else {
            self.settlement_unavailable_reason = Some(
                "Queued work, background commands or delegated work cannot be verified for this session right now.",
            );
            return self;
        };
        let quiet = !process_active
            && !archived
            && !pending
            && !self.requires_attention
            && !self.snoozed
            && matches!(status, Some("idle" | "completed" | "cancelled"));
        self.settled = quiet
            && settlement.is_some_and(|saved| {
                saved.after_seq >= 0
                    && saved.queue_fingerprint == fingerprint
                    && !woke_after(events, saved.after_seq)
                    && !events.iter().any(|event| {
                        event.seq() > saved.after_seq
                            && matches!(
                                event,
                                StructuredSessionEvent::UserMessageAccepted { .. }
                                    | StructuredSessionEvent::CommandAccepted { .. }
                            )
                    })
            });
        self.can_settle = quiet && !self.settled;
        self
    }
}

pub(super) fn has_pending_request(events: &[StructuredSessionEvent]) -> bool {
    let mut approvals: HashMap<(String, String), bool> = HashMap::new();
    let mut legacy_input = false;
    for event in events {
        match event {
            StructuredSessionEvent::ApprovalRequired {
                approval_id,
                turn_id,
                seq,
                ..
            } => {
                approvals
                    .entry((
                        turn_id.clone().unwrap_or_default(),
                        approval_id
                            .clone()
                            .unwrap_or_else(|| format!("legacy-{seq}")),
                    ))
                    .or_insert(false);
            }
            StructuredSessionEvent::ApprovalDecisionReserved {
                approval_id,
                turn_id,
                ..
            }
            | StructuredSessionEvent::ApprovalDecisionStarted {
                approval_id,
                turn_id,
                ..
            } => {
                approvals.insert((turn_id.clone(), approval_id.clone()), true);
            }
            StructuredSessionEvent::ApprovalResolved {
                approval_id,
                turn_id,
                ..
            }
            | StructuredSessionEvent::ApprovalDecisionReviewed {
                approval_id,
                turn_id,
                ..
            } => {
                approvals.remove(&(turn_id.clone(), approval_id.clone()));
            }
            StructuredSessionEvent::InputRequired { .. } => legacy_input = true,
            StructuredSessionEvent::TurnCompleted { turn_id, .. } => {
                approvals.retain(|(id, _), uncertain| id != turn_id || *uncertain);
                legacy_input = false;
            }
            StructuredSessionEvent::Status { status, .. } if status == "idle" => {
                approvals.retain(|_, uncertain| *uncertain);
                legacy_input = false;
            }
            _ => {}
        }
    }
    legacy_input || !approvals.is_empty()
}

pub(super) fn woke_after(events: &[StructuredSessionEvent], after_seq: i64) -> bool {
    events
        .iter()
        .filter(|event| event.seq() > after_seq)
        .any(|event| match event {
            StructuredSessionEvent::ApprovalRequired { .. }
            | StructuredSessionEvent::ApprovalDecisionReserved { .. }
            | StructuredSessionEvent::ApprovalDecisionStarted { .. }
            | StructuredSessionEvent::InputRequired { .. }
            | StructuredSessionEvent::Error { .. } => true,
            StructuredSessionEvent::TurnCompleted { status, .. } => {
                matches!(status.as_str(), "failed" | "interrupted")
            }
            StructuredSessionEvent::Status { status, .. } => matches!(
                status.as_str(),
                "cleanup_required" | "reconciliation_required"
            ),
            _ => false,
        })
}

const AUTO_SETTLE_ENV: &str = "TERMINAL_AUTO_SETTLE_IDLE_SECONDS";
const AUTO_SETTLE_MIN_SECONDS: i64 = 300;
const AUTO_SETTLE_MAX_SECONDS: i64 = 2_592_000;
#[cfg(unix)]
const AUTO_SETTLE_SWEEP_INTERVAL_MS: i64 = 30_000;

pub(super) fn parse_auto_settle_idle_ms(value: Option<&str>) -> Option<i64> {
    let seconds: i64 = value?.trim().parse().ok()?;
    (AUTO_SETTLE_MIN_SECONDS..=AUTO_SETTLE_MAX_SECONDS)
        .contains(&seconds)
        .then_some(seconds * 1000)
}

pub(super) fn auto_settle_due(last_activity_at: &str, now_ms: i64, idle_ms: i64) -> bool {
    time::OffsetDateTime::parse(
        last_activity_at,
        &time::format_description::well_known::Rfc3339,
    )
    .map(|at| {
        let last_ms = (at.unix_timestamp_nanos() / 1_000_000) as i64;
        now_ms.saturating_sub(last_ms) >= idle_ms
    })
    .unwrap_or(false)
}

#[cfg(unix)]
type AutoSettleSweepKey = (std::path::PathBuf, String);

#[cfg(unix)]
struct AutoSettleSweep {
    last_attempt: std::time::Instant,
    running: bool,
}

#[cfg(unix)]
#[derive(Default)]
struct AutoSettleSweeps {
    entries: HashMap<AutoSettleSweepKey, AutoSettleSweep>,
}

#[cfg(unix)]
impl AutoSettleSweeps {
    fn claim(&mut self, key: AutoSettleSweepKey, now: std::time::Instant) -> bool {
        if let Some(sweep) = self.entries.get_mut(&key) {
            if sweep.running
                || now.saturating_duration_since(sweep.last_attempt)
                    < std::time::Duration::from_millis(AUTO_SETTLE_SWEEP_INTERVAL_MS as u64)
            {
                return false;
            }
            sweep.last_attempt = now;
            sweep.running = true;
            return true;
        }

        if self.entries.len() >= 4096 {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, sweep)| !sweep.running)
                .min_by_key(|(_, sweep)| sweep.last_attempt)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                return false;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            key,
            AutoSettleSweep {
                last_attempt: now,
                running: true,
            },
        );
        true
    }

    fn finish(&mut self, key: &AutoSettleSweepKey, now: std::time::Instant) {
        if let Some(sweep) = self.entries.get_mut(key) {
            sweep.last_attempt = now;
            sweep.running = false;
        }
    }
}

#[cfg(unix)]
fn auto_settle_sweeps() -> &'static std::sync::Mutex<AutoSettleSweeps> {
    static SWEEPS: std::sync::OnceLock<std::sync::Mutex<AutoSettleSweeps>> =
        std::sync::OnceLock::new();
    SWEEPS.get_or_init(Default::default)
}

#[cfg(unix)]
struct AutoSettleSweepGuard(AutoSettleSweepKey);

#[cfg(unix)]
impl Drop for AutoSettleSweepGuard {
    fn drop(&mut self) {
        if let Ok(mut sweeps) = auto_settle_sweeps().lock() {
            sweeps.finish(&self.0, std::time::Instant::now());
        }
    }
}

#[cfg(unix)]
impl super::StructuredSessionManager {
    async fn settle_inventory_candidate(
        &self,
        owner: &str,
        item: &super::StructuredSessionInventory,
    ) -> bool {
        let update = super::StructuredThreadUpdate {
            settled: Some(true),
            pinned: Some(false),
            ..Default::default()
        };
        matches!(
            self.update_thread_inner(owner, &item.id, update, None, Some(item))
                .await,
            Ok(Some(_))
        )
    }

    pub(super) async fn auto_settle_idle_at(
        &self,
        owner: &str,
        idle_ms: i64,
        now_ms: i64,
    ) -> Result<Vec<String>, String> {
        let mut settled = Vec::new();
        for item in self.list_inventory(owner).await? {
            let Some(thread) = item.thread.as_ref() else {
                continue;
            };
            if !item.thread_lifecycle.can_settle
                || thread.pinned
                || !auto_settle_due(&thread.last_activity_at, now_ms, idle_ms)
            {
                continue;
            }
            if self.settle_inventory_candidate(owner, &item).await {
                settled.push(item.id);
            }
        }
        Ok(settled)
    }

    pub(super) fn schedule_auto_settle(&self, owner: &str) {
        let Some(idle_ms) =
            parse_auto_settle_idle_ms(std::env::var(AUTO_SETTLE_ENV).ok().as_deref())
        else {
            return;
        };
        let Ok(permit) = self.external_admission() else {
            return;
        };
        let Ok(data_root) = self.inner.config.data_dir.canonicalize() else {
            return;
        };
        let key = (data_root, owner.to_owned());
        let Ok(mut sweeps) = auto_settle_sweeps().lock() else {
            return;
        };
        if !sweeps.claim(key.clone(), std::time::Instant::now()) {
            return;
        }
        drop(sweeps);
        let sweep = AutoSettleSweepGuard(key);
        let manager = self.clone();
        let owner = owner.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            let _sweep = sweep;
            if manager
                .auto_settle_idle_at(&owner, idle_ms, super::now_ts())
                .await
                .is_err()
            {
                tracing::warn!("Automatic thread settlement was skipped; state was unavailable");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(value: serde_json::Value) -> StructuredSessionEvent {
        serde_json::from_value(value).unwrap()
    }

    fn approval(seq: i64, id: &str) -> StructuredSessionEvent {
        event(
            json!({"type":"approval_required","ts":seq,"seq":seq,"approvalId":id,"turnId":"turn", "toolName":"run_command","toolInput":{},"description":"Review"}),
        )
    }

    fn resolved(seq: i64, id: &str) -> StructuredSessionEvent {
        event(
            json!({"type":"approval_resolved","ts":seq,"seq":seq,"approvalId":id,"turnId":"turn","approved":false}),
        )
    }

    #[test]
    fn pending_requests_track_each_approval_and_legacy_input_until_resolved() {
        let mut events = vec![approval(1, "a"), approval(2, "b"), resolved(3, "a")];
        assert!(has_pending_request(&events));
        events.push(resolved(4, "b"));
        assert!(!has_pending_request(&events));
        events.push(event(
            json!({"type":"input_required","ts":5,"seq":5,"prompt":"Answer"}),
        ));
        assert!(has_pending_request(&events));
        events.push(event(
            json!({"type":"status","ts":6,"seq":6,"status":"idle"}),
        ));
        assert!(!has_pending_request(&events));
    }

    #[test]
    fn unresolved_codex_decisions_remain_attention_after_turn_completion() {
        let events = vec![
            approval(1, "a"),
            event(
                json!({"type":"approval_decision_started","ts":2,"seq":2,"approvalId":"a","turnId":"turn","approved":true,"forSession":false}),
            ),
            event(
                json!({"type":"turn_completed","ts":3,"seq":3,"turnId":"turn","status":"interrupted"}),
            ),
        ];
        assert!(has_pending_request(&events));
    }

    #[test]
    fn new_requests_and_failures_wake_even_if_resolved_afterward() {
        let events = vec![approval(3, "a"), resolved(4, "a")];
        assert!(woke_after(&events, 2));
        assert!(!woke_after(&events, 4));
        let failure = event(json!({"type":"error","ts":5,"seq":5,"message":"Failed"}));
        assert!(woke_after(&[failure], 4));
    }

    #[tokio::test]
    async fn snooze_survives_restart_wakes_on_request_and_rejects_pending_or_foreign_edits() {
        use super::super::{StructuredSessionManager, StructuredThreadUpdate};
        use terminal_v4_core::AppConfig;
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        };
        let manager = StructuredSessionManager::new(config.clone());
        let snapshot = manager
            .create_session(
                "owner",
                dir.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let update = StructuredThreadUpdate {
            snooze_for_seconds: Some(3600),
            ..Default::default()
        };
        let thread = manager
            .update_thread("owner", &snapshot.id, update.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(thread.snooze.is_some());
        assert!(manager
            .update_thread("foreign", &snapshot.id, update.clone())
            .await
            .unwrap()
            .is_none());
        drop(manager);
        let reopened = StructuredSessionManager::new(config.clone());
        let inventory = reopened.list_inventory("owner").await.unwrap();
        assert!(inventory[0].thread_lifecycle.snoozed);
        reopened
            .record_event("owner", &snapshot.id, approval(1, "new"))
            .await
            .unwrap();
        let inventory = reopened.list_inventory("owner").await.unwrap();
        assert!(!inventory[0].thread_lifecycle.snoozed);
        assert!(inventory[0].thread_lifecycle.requires_attention);
        assert!(reopened
            .update_thread("owner", &snapshot.id, update)
            .await
            .is_err());
        reopened
            .record_event("owner", &snapshot.id, resolved(2, "new"))
            .await
            .unwrap();
        drop(reopened);
        let restarted = StructuredSessionManager::new(config);
        let inventory = restarted.list_inventory("owner").await.unwrap();
        assert!(
            !inventory[0].thread_lifecycle.snoozed,
            "a resolved request must not re-snooze after restart"
        );
        assert!(!inventory[0].thread_lifecycle.requires_attention);
        assert!(restarted
            .update_thread(
                "owner",
                &snapshot.id,
                StructuredThreadUpdate {
                    wake_snooze: true,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .unwrap()
            .snooze
            .is_none());
    }

    #[test]
    fn expiry_and_unknown_status_never_hide_a_thread() {
        let snooze = StructuredSnooze {
            until_ms: 100,
            after_seq: 0,
        };
        assert!(project(&[], Some(&snooze), Some("running"), 99, false).snoozed);
        assert!(!project(&[], Some(&snooze), Some("running"), 100, false).snoozed);
        assert!(!project(&[], Some(&snooze), None, 0, false).snoozed);
        assert!(project(&[], Some(&snooze), None, 0, false).requires_attention);
        assert!(project(&[], Some(&snooze), Some("running"), 99, true).requires_attention);
    }

    #[test]
    fn legacy_thread_metadata_without_snooze_still_loads() {
        let legacy: terminal_v4_core::StructuredThreadMetadata = serde_json::from_value(json!({
            "topic":null,"topicAutoGenerated":false,"pinned":false,"archived":false,
            "projectPath":null,"lastActivityAt":"2026-01-01T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(legacy.snooze, None);
    }

    #[test]
    fn settled_metadata_round_trips_separate_from_archive() {
        let input = json!({
            "topic":null,"topicAutoGenerated":false,"pinned":false,"archived":false,
            "projectPath":null,"lastActivityAt":"2026-01-01T00:00:00Z",
            "settlement":{"afterSeq":12,"queueFingerprint":"0123456789abcdef"}
        });
        let parsed: terminal_v4_core::StructuredThreadMetadata =
            serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), input);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn settled_v4_thread_survives_restart_and_wakes_for_queue_or_user_activity() {
        use super::super::StructuredThreadUpdate;
        use crate::followup_queue::{Mutation, QueueOperation, QueueScope, QueueStore};
        use terminal_v4_core::AppConfig;
        use uuid::Uuid;

        let data = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config.clone()).unwrap();
        let manager = state.structured_session_manager();
        let session = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        manager
            .update_thread(
                "owner",
                &session.id,
                StructuredThreadUpdate {
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let update = StructuredThreadUpdate {
            settled: Some(true),
            ..Default::default()
        };
        let thread = manager
            .update_thread("owner", &session.id, update.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(!thread.pinned);
        assert!(thread.settlement.is_some());
        assert!(manager
            .update_thread("other-owner", &session.id, update.clone())
            .await
            .unwrap()
            .is_none());
        manager.shutdown().await.unwrap();
        drop(manager);
        drop(state);

        let state = crate::state::AppState::new_runtime(config.clone()).unwrap();
        let reopened = state.structured_session_manager();
        let lifecycle = &reopened.list_inventory("owner").await.unwrap()[0].thread_lifecycle;
        assert!(lifecycle.settlement_supported && lifecycle.settled);
        let item_id = Uuid::new_v4();
        let receipt = reopened
            .queue_mutate(
                "owner",
                &session.id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: 0,
                    operation: QueueOperation::Enqueue {
                        item_id,
                        text: "later work".into(),
                        run_when_idle: false,
                    },
                },
            )
            .await
            .unwrap();
        let lifecycle = &reopened.list_inventory("owner").await.unwrap()[0].thread_lifecycle;
        assert!(!lifecycle.settled && !lifecycle.can_settle);
        assert!(reopened
            .update_thread("owner", &session.id, update.clone())
            .await
            .is_err());
        reopened
            .queue_mutate(
                "owner",
                &session.id,
                Mutation {
                    operation_id: Uuid::new_v4(),
                    expected_queue_revision: receipt.queue_revision,
                    operation: QueueOperation::Remove {
                        item_id,
                        expected_item_revision: receipt.item_revision.unwrap(),
                    },
                },
            )
            .await
            .unwrap();
        let lifecycle = &reopened.list_inventory("owner").await.unwrap()[0].thread_lifecycle;
        assert!(!lifecycle.settled && lifecycle.can_settle);
        reopened
            .update_thread("owner", &session.id, update)
            .await
            .unwrap();
        reopened.shutdown().await.unwrap();
        drop(reopened);
        drop(state);
        let scope = QueueScope::new("owner", data.path(), &session.id).unwrap();
        QueueStore::new(data.path(), Uuid::new_v4())
            .load(&scope)
            .unwrap();
        let state = crate::state::AppState::new_runtime(config.clone()).unwrap();
        let reopened = state.structured_session_manager();
        reopened.queue_snapshot("owner", &session.id).await.unwrap();
        assert!(
            reopened.list_inventory("owner").await.unwrap()[0]
                .thread_lifecycle
                .settled,
            "a restart hold without new work must not wake a settled thread"
        );
        reopened.record_event("owner", &session.id, event(json!({"type":"user_message_accepted","ts":1,"seq":1,"requestId":"request","turnId":"turn","messageId":"message","content":"continue"}))).await.unwrap();
        reopened.record_event("owner", &session.id, event(json!({"type":"turn_completed","ts":2,"seq":2,"turnId":"turn","status":"completed"}))).await.unwrap();
        reopened.shutdown().await.unwrap();
        drop(reopened);
        drop(state);
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let restarted = state.structured_session_manager();
        let lifecycle = &restarted.list_inventory("owner").await.unwrap()[0].thread_lifecycle;
        assert!(!lifecycle.settled && lifecycle.can_settle);
        assert!(restarted
            .update_thread(
                "owner",
                &session.id,
                StructuredThreadUpdate {
                    settled: Some(false),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .unwrap()
            .settlement
            .is_none());
        restarted.shutdown().await.unwrap();
    }

    #[test]
    fn settlement_never_hides_unknown_pending_or_running_state() {
        let settlement = StructuredSettlement {
            after_seq: 0,
            queue_fingerprint: "fixture".into(),
        };
        let lifecycle = project(&[], None, Some("idle"), 0, false);
        let pending = lifecycle.clone().with_settlement(
            Some(&settlement),
            Some(("fixture".into(), true)),
            false,
            false,
            Some("idle"),
            &[],
        );
        let unknown = lifecycle.clone().with_settlement(
            Some(&settlement),
            None,
            false,
            false,
            Some("idle"),
            &[],
        );
        let running = lifecycle.with_settlement(
            Some(&settlement),
            Some(("fixture".into(), false)),
            true,
            false,
            Some("idle"),
            &[],
        );
        assert!(!pending.settled && !pending.can_settle);
        assert!(!unknown.settled && !unknown.settlement_supported);
        assert!(!running.settled && !running.can_settle);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unresolved_delegated_child_prevents_parent_settlement_without_blocking_other_threads()
    {
        use super::super::StructuredThreadUpdate;
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let manager = state.structured_session_manager();
        let parent = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let other = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let incarnation = {
            let session = manager
                .owned_session("owner", &parent.id)
                .await
                .unwrap()
                .unwrap();
            let inner = session.state.lock().await;
            inner.session_incarnation.unwrap().0
        };
        manager
            .inner
            .delegation_supervisor
            .get()
            .unwrap()
            .seed_test_outstanding_parent(
                "owner",
                &parent.id,
                incarnation,
                &data.path().canonicalize().unwrap(),
            )
            .unwrap();
        let update = StructuredThreadUpdate {
            settled: Some(true),
            ..Default::default()
        };
        assert!(manager
            .update_thread("owner", &parent.id, update.clone())
            .await
            .is_err());
        assert!(manager
            .update_thread("owner", &other.id, update)
            .await
            .unwrap()
            .unwrap()
            .settlement
            .is_some());
        let inventory = manager.list_inventory("owner").await.unwrap();
        let parent = inventory.iter().find(|item| item.id == parent.id).unwrap();
        assert!(!parent.thread_lifecycle.settled && !parent.thread_lifecycle.can_settle);
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_owner_lease_prevents_a_second_manager_overwriting_snooze() {
        use super::super::StructuredThreadUpdate;
        use terminal_v4_core::AppConfig;
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            data_dir: dir.path().into(),
            ..Default::default()
        };
        let first = crate::state::AppState::new_runtime(config.clone()).unwrap();
        let second = crate::state::AppState::new_runtime(config).unwrap();
        let first_manager = first.structured_session_manager();
        let second_manager = second.structured_session_manager();
        let snapshot = first_manager
            .create_session(
                "owner",
                dir.path().to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        first_manager
            .update_thread(
                "owner",
                &snapshot.id,
                StructuredThreadUpdate {
                    snooze_for_seconds: Some(3600),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(second_manager
            .update_thread(
                "owner",
                &snapshot.id,
                StructuredThreadUpdate {
                    wake_snooze: true,
                    ..Default::default()
                }
            )
            .await
            .is_err());
        assert!(
            first_manager.list_inventory("owner").await.unwrap()[0]
                .thread_lifecycle
                .snoozed
        );
        first_manager.shutdown().await.unwrap();
        assert!(second_manager
            .update_thread(
                "owner",
                &snapshot.id,
                StructuredThreadUpdate {
                    wake_snooze: true,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .unwrap()
            .snooze
            .is_none());
        second_manager.shutdown().await.unwrap();
    }

    #[test]
    fn auto_settle_idle_period_is_off_unless_configured_within_bounds() {
        assert_eq!(parse_auto_settle_idle_ms(None), None);
        assert_eq!(parse_auto_settle_idle_ms(Some("")), None);
        assert_eq!(parse_auto_settle_idle_ms(Some("soon")), None);
        assert_eq!(parse_auto_settle_idle_ms(Some("0")), None);
        assert_eq!(parse_auto_settle_idle_ms(Some("299")), None);
        assert_eq!(parse_auto_settle_idle_ms(Some("2592001")), None);
        assert_eq!(parse_auto_settle_idle_ms(Some(" 3600 ")), Some(3_600_000));
    }

    #[test]
    fn auto_settle_is_due_only_after_a_parseable_idle_period() {
        let at = "2026-01-01T00:00:00Z";
        let at_ms = 1_767_225_600_000;
        assert!(!auto_settle_due(at, at_ms + 999, 1000));
        assert!(auto_settle_due(at, at_ms + 1000, 1000));
        assert!(!auto_settle_due("not a time", i64::MAX, 1000));
    }

    #[cfg(unix)]
    #[test]
    fn automatic_settlement_sweeps_do_not_starve_other_owners_or_data_roots() {
        let mut sweeps = AutoSettleSweeps::default();
        let first = ("/fixture-a".into(), "owner-a".into());
        let other_owner = ("/fixture-a".into(), "owner-b".into());
        let other_root = ("/fixture-b".into(), "owner-a".into());
        let now = std::time::Instant::now();
        let interval = std::time::Duration::from_millis(AUTO_SETTLE_SWEEP_INTERVAL_MS as u64);
        assert!(sweeps.claim(first.clone(), now));
        assert!(!sweeps.claim(first.clone(), now + interval));
        assert!(sweeps.claim(other_owner, now));
        assert!(sweeps.claim(other_root, now));
        sweeps.finish(&first, now);
        assert!(!sweeps.claim(
            first.clone(),
            now + interval - std::time::Duration::from_millis(1)
        ));
        assert!(sweeps.claim(first, now + interval));
    }

    #[cfg(unix)]
    #[test]
    fn automatic_settlement_sweep_capacity_preserves_running_entries() {
        let mut sweeps = AutoSettleSweeps::default();
        let now = std::time::Instant::now();
        for number in 0..4096 {
            assert!(sweeps.claim(("/fixture".into(), format!("owner-{number}")), now));
        }
        let newcomer = ("/fixture".into(), "newcomer".into());
        assert!(!sweeps.claim(newcomer.clone(), now));
        let finished = ("/fixture".into(), "owner-1".into());
        sweeps.finish(&finished, now);
        assert!(sweeps.claim(newcomer, now));
        assert_eq!(sweeps.entries.len(), 4096);
        assert!(!sweeps.entries.contains_key(&finished));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn snooze_choices_use_server_clock_enforce_bounds_and_survive_restart() {
        use super::super::StructuredThreadUpdate;
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config.clone()).unwrap();
        let manager = state.structured_session_manager();
        let session = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        for seconds in [0, 59, 2_592_001] {
            assert!(manager
                .update_thread(
                    "owner",
                    &session.id,
                    StructuredThreadUpdate {
                        snooze_for_seconds: Some(seconds),
                        ..Default::default()
                    }
                )
                .await
                .is_err());
        }
        let before = super::super::now_ts();
        let thread = manager
            .update_thread(
                "owner",
                &session.id,
                StructuredThreadUpdate {
                    snooze_for_seconds: Some(4 * 3600),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        let after = super::super::now_ts();
        let until = thread.snooze.unwrap().until_ms;
        assert!(until >= before + 4 * 3600 * 1000 && until <= after + 4 * 3600 * 1000);
        manager.shutdown().await.unwrap();
        drop(manager);
        drop(state);
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let reopened = state.structured_session_manager();
        let lifecycle = &reopened.list_inventory("owner").await.unwrap()[0].thread_lifecycle;
        assert_eq!(lifecycle.snoozed_until_ms, Some(until));
        assert!(lifecycle.snoozed);
        reopened.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn automatic_settlement_rejects_an_inventory_snapshot_after_a_completed_turn() {
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let manager = state.structured_session_manager();
        let session = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        let candidate = manager
            .list_inventory("owner")
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert!(candidate.thread_lifecycle.can_settle);
        assert!(serde_json::to_value(&candidate)
            .unwrap()
            .get("sessionIncarnation")
            .is_none());
        manager
            .record_event(
                "owner",
                &session.id,
                event(json!({"type":"turn_started","ts":1,"seq":1,"turnId":"new-turn"})),
            )
            .await
            .unwrap();
        manager
            .record_event(
                "owner",
                &session.id,
                event(json!({"type":"turn_completed","ts":2,"seq":2,"turnId":"new-turn","status":"completed"})),
            )
            .await
            .unwrap();
        assert!(
            !manager
                .settle_inventory_candidate("owner", &candidate)
                .await
        );
        assert!(manager
            .get_thread("owner", &session.id)
            .await
            .unwrap()
            .unwrap()
            .settlement
            .is_none());
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn automatic_settlement_skips_pinned_pending_native_and_delegated_threads() {
        use super::super::StructuredThreadUpdate;
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let manager = state.structured_session_manager();
        let cwd = data.path().to_str().unwrap();
        let mut ids = Vec::new();
        for _ in 0..5 {
            ids.push(
                manager
                    .create_session("owner", cwd, Some("deepseek"), Some("deepseek-chat"), None)
                    .await
                    .unwrap()
                    .id,
            );
        }
        let (idle, pinned, pending, delegated, snoozed) =
            (&ids[0], &ids[1], &ids[2], &ids[3], &ids[4]);
        let native = manager
            .create_session("owner", cwd, Some("claude"), None, None)
            .await
            .unwrap()
            .id;
        manager
            .update_thread(
                "owner",
                pinned,
                StructuredThreadUpdate {
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        manager
            .update_thread(
                "owner",
                snoozed,
                StructuredThreadUpdate {
                    snooze_for_seconds: Some(3600),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        manager
            .record_event("owner", pending, approval(1, "a"))
            .await
            .unwrap();
        let incarnation = {
            let session = manager
                .owned_session("owner", delegated)
                .await
                .unwrap()
                .unwrap();
            let inner = session.state.lock().await;
            inner.session_incarnation.unwrap().0
        };
        manager
            .inner
            .delegation_supervisor
            .get()
            .unwrap()
            .seed_test_outstanding_parent(
                "owner",
                delegated,
                incarnation,
                &data.path().canonicalize().unwrap(),
            )
            .unwrap();

        let far_future = super::super::now_ts() + 10_000_000;
        assert!(manager
            .auto_settle_idle_at("owner", 1000, 0)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            manager
                .auto_settle_idle_at("owner", 1000, far_future)
                .await
                .unwrap(),
            vec![idle.clone()]
        );
        let inventory = manager.list_inventory("owner").await.unwrap();
        let settled: Vec<_> = inventory
            .iter()
            .filter(|item| item.thread_lifecycle.settled)
            .map(|item| item.id.clone())
            .collect();
        assert_eq!(settled, vec![idle.clone()]);
        assert!(inventory
            .iter()
            .find(|item| item.id == native)
            .is_some_and(|item| !item.thread_lifecycle.settlement_supported
                && !item.thread_lifecycle.can_settle));
        assert!(manager
            .auto_settle_idle_at("owner", 1000, far_future)
            .await
            .unwrap()
            .is_empty());
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn settle_with_explicit_unpinned_assertion_rejects_a_pinned_thread() {
        use super::super::StructuredThreadUpdate;
        let data = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: data.path().into(),
            ..Default::default()
        };
        let state = crate::state::AppState::new_runtime(config).unwrap();
        let manager = state.structured_session_manager();
        let session = manager
            .create_session(
                "owner",
                data.path().to_str().unwrap(),
                Some("deepseek"),
                Some("deepseek-chat"),
                None,
            )
            .await
            .unwrap();
        manager
            .update_thread(
                "owner",
                &session.id,
                StructuredThreadUpdate {
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(manager
            .update_thread(
                "owner",
                &session.id,
                StructuredThreadUpdate {
                    settled: Some(true),
                    pinned: Some(false),
                    ..Default::default()
                }
            )
            .await
            .is_err());
        assert!(
            manager.list_inventory("owner").await.unwrap()[0]
                .thread
                .as_ref()
                .unwrap()
                .pinned
        );
        manager.shutdown().await.unwrap();
    }
}
