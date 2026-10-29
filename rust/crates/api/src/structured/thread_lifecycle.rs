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
}
