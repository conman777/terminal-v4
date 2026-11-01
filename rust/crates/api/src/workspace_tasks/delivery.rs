use super::*;

const SUMMARY_BODY_CHARS: usize = 3000;
const SUMMARY_TITLE_CHARS: usize = 80;
const UNKNOWN_AFTER_RESTART: &str =
    "A restart interrupted delivery; the message may or may not have been sent, so it was not sent again";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryTarget {
    Telegram,
    Slack,
    Discord,
    Webhook,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Pending,
    Delivered,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_to: Option<DeliveryTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<DeliveryStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_attempted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_at: Option<u64>,
}

impl DeliveryState {
    pub(super) fn pending(target: Option<DeliveryTarget>) -> Self {
        Self {
            deliver_to: target,
            delivery_status: target.map(|_| DeliveryStatus::Pending),
            ..Default::default()
        }
    }

    pub(super) fn progress(&self) -> u8 {
        match (self.delivery_status, self.delivery_attempted_at) {
            (None, _) | (Some(DeliveryStatus::Pending), None) => 0,
            (Some(DeliveryStatus::Pending), Some(_)) => 1,
            _ => 2,
        }
    }
}

pub(super) fn mark_for_delivery(
    store: &mut TaskStore,
    id: Uuid,
    target: Option<DeliveryTarget>,
) -> Option<TaskRecord> {
    let task = store.tasks.iter_mut().find(|task| task.id == id)?;
    task.delivery = DeliveryState::pending(target);
    Some(task.clone())
}

fn status_label(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::Completed => "Completed",
        TaskStatus::Failed => "Failed",
        TaskStatus::Cancelled => "Cancelled",
        TaskStatus::Interrupted => "Interrupted (outcome unknown)",
        _ => "Finished",
    }
}

fn shorten(text: &str, limit: usize) -> String {
    let clean = crate::session_search::safe_history_text(text);
    let clean = clean.trim();
    if clean.chars().count() <= limit {
        return clean.to_owned();
    }
    let mut shortened: String = clean.chars().take(limit).collect();
    shortened.push('…');
    shortened
}

pub(super) fn summary(task: &TaskRecord, schedule_name: Option<&str>) -> String {
    let title = schedule_name
        .map(str::to_owned)
        .unwrap_or_else(|| task.input.prompt.lines().next().unwrap_or("").to_owned());
    let body = [task.result.as_str(), task.error.as_deref().unwrap_or("")]
        .into_iter()
        .find(|text| !text.trim().is_empty())
        .unwrap_or("No text result.");
    format!(
        "Terminal v4 schedule: {}\nStatus: {}\n\n{}",
        shorten(&title, SUMMARY_TITLE_CHARS),
        status_label(&task.status),
        shorten(body, SUMMARY_BODY_CHARS)
    )
}

pub(super) struct PendingDelivery {
    owner: String,
    task_id: Uuid,
    target: DeliveryTarget,
    text: String,
}

pub(super) fn claim_deliveries(
    data_dir: &FsPath,
    recover: bool,
) -> Result<Vec<PendingDelivery>, ApiError> {
    #[cfg(test)]
    if std::env::var_os("TASK_TEST_DELIVERY_HOLD").is_some_and(|hold| FsPath::new(&hold).exists()) {
        return Ok(Vec::new());
    }
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| ApiError::internal("Task storage unavailable"))?;
    let _file_guard = store_file_lock(data_dir)?;
    let mut claimed = Vec::new();
    for mut store in load_owner_stores(data_dir)? {
        let now = now_ms();
        let mut changed = false;
        let names: Vec<_> = store
            .schedules
            .iter()
            .map(|schedule| (schedule.id, schedule.name.clone()))
            .collect();
        for task in store.tasks.iter_mut().filter(|task| {
            task.status.terminal()
                && task.delivery.deliver_to.is_some()
                && task.delivery.delivery_status == Some(DeliveryStatus::Pending)
        }) {
            if task.delivery.delivery_attempted_at.is_some() {
                if recover {
                    task.delivery.delivery_status = Some(DeliveryStatus::Failed);
                    task.delivery.delivery_reason = Some(UNKNOWN_AFTER_RESTART.into());
                    task.delivery.delivery_at = Some(now);
                    changed = true;
                }
                continue;
            }
            task.delivery.delivery_attempted_at = Some(now);
            changed = true;
            let name = names
                .iter()
                .find(|(id, _)| Some(*id) == task.schedule_id)
                .map(|(_, name)| name.as_str());
            claimed.push(PendingDelivery {
                owner: store.owner_id.clone(),
                task_id: task.id,
                target: task.delivery.deliver_to.unwrap_or(DeliveryTarget::Telegram),
                text: summary(task, name),
            });
        }
        if changed {
            if let Err(error) = write_store(data_dir, &store) {
                let owner = store.owner_id.clone();
                claimed.retain(|item| item.owner != owner);
                tracing::warn!(owner = %owner, error = %error.message, "Delivery marker could not be saved; nothing was sent for this owner");
            }
        }
    }
    Ok(claimed)
}

async fn record_outcome(
    data_dir: &FsPath,
    owner: &str,
    id: Uuid,
    status: DeliveryStatus,
    reason: Option<String>,
) {
    for attempt in 0..5u64 {
        let reason = reason.clone();
        let saved = edit_store(data_dir.into(), owner.into(), move |store| {
            if let Some(task) = store
                .tasks
                .iter_mut()
                .find(|task| task.id == id)
                .filter(|task| task.delivery.delivery_status == Some(DeliveryStatus::Pending))
            {
                task.delivery.delivery_status = Some(status);
                task.delivery.delivery_reason = reason;
                task.delivery.delivery_at = Some(now_ms());
            }
            Ok(())
        })
        .await;
        if saved.is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200 * (attempt + 1))).await;
    }
    tracing::error!(task_id = %id, "Delivery finished but its outcome could not be saved");
}

pub(super) async fn deliver(data_dir: PathBuf, item: PendingDelivery) {
    let (status, reason) = match item.target {
        DeliveryTarget::Telegram => {
            match crate::telegram_gateway::send_to_owner(&data_dir, &item.owner, &item.text).await {
                Ok(()) => (DeliveryStatus::Delivered, None),
                Err(error) if error.skipped() => {
                    (DeliveryStatus::Skipped, Some(error.reason().to_owned()))
                }
                Err(error) => (DeliveryStatus::Failed, Some(error.reason().to_owned())),
            }
        }
        DeliveryTarget::Slack | DeliveryTarget::Discord | DeliveryTarget::Webhook => {
            let channel = match item.target {
                DeliveryTarget::Slack => delivery_channels::Channel::Slack,
                DeliveryTarget::Discord => delivery_channels::Channel::Discord,
                _ => delivery_channels::Channel::Webhook,
            };
            match delivery_channels::send(&data_dir, &item.owner, channel, item.task_id, &item.text)
                .await
            {
                Ok(()) => (DeliveryStatus::Delivered, None),
                Err(error) if error.skipped() => {
                    (DeliveryStatus::Skipped, Some(error.reason().to_owned()))
                }
                Err(error) => (DeliveryStatus::Failed, Some(error.reason().to_owned())),
            }
        }
    };
    record_outcome(&data_dir, &item.owner, item.task_id, status, reason).await;
}

pub(super) async fn drain(deliveries: &mut tokio::task::JoinSet<()>) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while deliveries.join_next().await.is_some() {}
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(owner_data: &FsPath, owner: &str, target: Option<DeliveryTarget>) -> Uuid {
        let mut store = TaskStore {
            owner_id: owner.into(),
            ..Default::default()
        };
        let input = TaskInput {
            workspace_path: owner_data.to_string_lossy().into_owned(),
            provider: "codex".into(),
            prompt: "Summarise issues\nand more".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        let id = enqueue(&mut store, input, None, 1).unwrap().id;
        delivery::mark_for_delivery(&mut store, id, target);
        let task = &mut store.tasks[0];
        task.result = "all good".into();
        transition(task, TaskStatus::Completed, "done", 5);
        write_store(owner_data, &store).unwrap();
        id
    }

    fn task_delivery(data: &FsPath, owner: &str) -> DeliveryState {
        read_store(data, owner).unwrap().tasks.remove(0).delivery
    }

    #[test]
    fn summary_is_bounded_redacted_and_names_status_and_title() {
        let mut store = TaskStore::default();
        let input = TaskInput {
            workspace_path: "/tmp".into(),
            provider: "codex".into(),
            prompt: "prompt line\nsecond".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        let id = enqueue(&mut store, input, None, 1).unwrap().id;
        let task = &mut store.tasks[0];
        task.result = format!("API_KEY=hunter2\n{}", "x".repeat(10_000));
        transition(task, TaskStatus::Failed, "bad", 2);
        let text = summary(task, Some("Nightly review"));
        let untitled = summary(task, None);
        assert_eq!(
            (
                id == task.id,
                text.starts_with("Terminal v4 schedule: Nightly review\nStatus: Failed\n\n"),
                text.contains("hunter2"),
                text.chars().count() < SUMMARY_BODY_CHARS + 120,
                text.ends_with('…'),
                untitled.starts_with("Terminal v4 schedule: prompt line\n"),
            ),
            (true, true, false, true, true, true)
        );
    }

    #[test]
    fn empty_result_falls_back_to_the_error_then_a_placeholder() {
        let mut store = TaskStore::default();
        let input = TaskInput {
            workspace_path: "/tmp".into(),
            provider: "codex".into(),
            prompt: "p".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        enqueue(&mut store, input, None, 1).unwrap();
        let task = &mut store.tasks[0];
        task.error = Some("agent crashed".into());
        let with_error = summary(task, Some("S"));
        task.error = None;
        assert_eq!(
            (
                with_error.ends_with("agent crashed"),
                summary(task, Some("S")).ends_with("No text result.")
            ),
            (true, true)
        );
    }

    #[test]
    fn a_finished_task_is_claimed_once_and_nothing_else_is() {
        let data = tempfile::tempdir().unwrap();
        let wanted = finished(data.path(), "a", Some(DeliveryTarget::Telegram));
        finished(data.path(), "b", None);
        let first = claim_deliveries(data.path(), true).unwrap();
        let second = claim_deliveries(data.path(), false).unwrap();
        assert_eq!(
            (
                first
                    .iter()
                    .map(|item| (item.owner.clone(), item.task_id))
                    .collect::<Vec<_>>(),
                second.len(),
                task_delivery(data.path(), "a").delivery_status,
                task_delivery(data.path(), "a")
                    .delivery_attempted_at
                    .is_some(),
                task_delivery(data.path(), "b"),
            ),
            (
                vec![("a".to_owned(), wanted)],
                0,
                Some(DeliveryStatus::Pending),
                true,
                DeliveryState::default()
            )
        );
    }

    #[test]
    fn a_claim_left_by_a_dead_worker_is_reported_unknown_and_never_resent() {
        let data = tempfile::tempdir().unwrap();
        finished(data.path(), "a", Some(DeliveryTarget::Telegram));
        claim_deliveries(data.path(), true).unwrap();
        let again = claim_deliveries(data.path(), true).unwrap();
        let state = task_delivery(data.path(), "a");
        assert_eq!(
            (
                again.len(),
                state.delivery_status,
                state
                    .delivery_reason
                    .is_some_and(|reason| reason.contains("not sent again")),
                claim_deliveries(data.path(), true).unwrap().len(),
            ),
            (0, Some(DeliveryStatus::Failed), true, 0)
        );
    }

    #[test]
    fn running_tasks_wait_for_a_terminal_state_before_delivery() {
        let data = tempfile::tempdir().unwrap();
        let mut store = TaskStore {
            owner_id: "a".into(),
            ..Default::default()
        };
        let input = TaskInput {
            workspace_path: data.path().to_string_lossy().into_owned(),
            provider: "codex".into(),
            prompt: "p".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        let id = enqueue(&mut store, input, None, 1).unwrap().id;
        delivery::mark_for_delivery(&mut store, id, Some(DeliveryTarget::Telegram));
        transition(&mut store.tasks[0], TaskStatus::Running, "go", 2);
        write_store(data.path(), &store).unwrap();
        assert_eq!(claim_deliveries(data.path(), true).unwrap().len(), 0);
    }

    #[test]
    fn a_stale_receipt_cannot_erase_a_recorded_delivery() {
        let mut stored = TaskStore::default();
        let input = TaskInput {
            workspace_path: "/tmp".into(),
            provider: "codex".into(),
            prompt: "p".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        enqueue(&mut stored, input, None, 1).unwrap();
        let id = stored.tasks[0].id;
        delivery::mark_for_delivery(&mut stored, id, Some(DeliveryTarget::Telegram));
        let mut receipt = stored.tasks[0].clone();
        transition(&mut receipt, TaskStatus::Completed, "done", 3);
        let mut existing = receipt.clone();
        existing.delivery.delivery_attempted_at = Some(4);
        existing.delivery.delivery_status = Some(DeliveryStatus::Delivered);
        merge_completion(&mut existing, receipt);
        assert_eq!(
            existing.delivery.delivery_status,
            Some(DeliveryStatus::Delivered)
        );
    }

    #[test]
    fn records_expose_delivery_fields_and_old_records_still_load() {
        let mut store = TaskStore::default();
        let input = TaskInput {
            workspace_path: "/tmp".into(),
            provider: "codex".into(),
            prompt: "p".into(),
            model: None,
            parent_session_id: None,
            parent_task_id: None,
        };
        enqueue(&mut store, input, None, 1).unwrap();
        let plain = serde_json::to_value(&store.tasks[0]).unwrap();
        let id = store.tasks[0].id;
        delivery::mark_for_delivery(&mut store, id, Some(DeliveryTarget::Telegram));
        let marked = serde_json::to_value(&store.tasks[0]).unwrap();
        let round_trip: TaskRecord = serde_json::from_value(marked.clone()).unwrap();
        let old: TaskRecord = serde_json::from_value(plain.clone()).unwrap();
        assert_eq!(
            (
                plain.get("deliveryStatus").cloned(),
                marked["deliverTo"].clone(),
                marked["deliveryStatus"].clone(),
                round_trip.delivery.delivery_status,
                old.delivery,
            ),
            (
                None,
                serde_json::json!("telegram"),
                serde_json::json!("pending"),
                Some(DeliveryStatus::Pending),
                DeliveryState::default()
            )
        );
    }
}
