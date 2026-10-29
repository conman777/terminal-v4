use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_LOGS_PER_PORT: usize = 200;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyLogEntry {
    pub id: String,
    pub timestamp: i64,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub duration: i64,
    pub request_size: Option<usize>,
    pub response_size: Option<usize>,
    pub content_type: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProxyLogInput {
    pub timestamp: i64,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub duration: i64,
    pub request_size: Option<usize>,
    pub response_size: Option<usize>,
    pub content_type: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct RequestLogStore {
    logs: Arc<Mutex<HashMap<String, Vec<ProxyLogEntry>>>>,
    next_sequence: Arc<AtomicU64>,
}

impl RequestLogStore {
    pub fn new() -> Self {
        Self {
            logs: Arc::new(Mutex::new(HashMap::new())),
            next_sequence: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn add_log(&self, user_id: &str, port: u16, input: ProxyLogInput) {
        let mut logs = self.logs.lock().await;
        let port_logs = logs.entry(store_key(user_id, port)).or_default();
        port_logs.push(ProxyLogEntry {
            id: format!(
                "{:016x}-{}",
                self.next_sequence.fetch_add(1, Ordering::Relaxed),
                Uuid::new_v4()
            ),
            timestamp: input.timestamp,
            method: input.method,
            url: input.url,
            status: input.status,
            status_text: input.status_text,
            duration: input.duration,
            request_size: input.request_size,
            response_size: input.response_size,
            content_type: input.content_type,
            error: input.error,
        });
        if port_logs.len() > MAX_LOGS_PER_PORT {
            port_logs.remove(0);
        }
    }

    pub async fn get_logs(
        &self,
        user_id: &str,
        port: u16,
        since: Option<i64>,
    ) -> Vec<ProxyLogEntry> {
        let logs = self.logs.lock().await;
        let Some(entries) = logs.get(&store_key(user_id, port)) else {
            return Vec::new();
        };

        match since {
            Some(since) => entries
                .iter()
                .filter(|entry| entry.timestamp > since)
                .cloned()
                .collect(),
            None => entries.clone(),
        }
    }

    pub async fn get_logs_after_cursor(
        &self,
        user_id: &str,
        port: u16,
        cursor: LogCursor,
    ) -> Vec<ProxyLogEntry> {
        let logs = self.logs.lock().await;
        let Some(entries) = logs.get(&store_key(user_id, port)) else {
            return Vec::new();
        };

        if let Some(id) = &cursor.id {
            if let Some(index) = entries.iter().position(|entry| &entry.id == id) {
                return entries[index + 1..].to_vec();
            }
            // Unknown, evicted, cleared or foreign-scope cursors replay only the retained ring.
            return entries.clone();
        }
        entries
            .iter()
            .filter(|entry| cursor.timestamp <= 0 || entry.timestamp > cursor.timestamp)
            .cloned()
            .collect()
    }

    pub async fn clear_logs(&self, user_id: &str, port: u16) {
        let mut logs = self.logs.lock().await;
        logs.remove(&store_key(user_id, port));
    }
}

#[derive(Debug, Clone, Default)]
pub struct LogCursor {
    pub timestamp: i64,
    pub id: Option<String>,
}

impl LogCursor {
    pub fn for_resume(timestamp: i64, id: Option<&str>) -> Result<Self, String> {
        if let Some(id) = id {
            let valid = id.len() == 53
                && id.split_once('-').is_some_and(|(sequence, uuid)| {
                    sequence.len() == 16
                        && u64::from_str_radix(sequence, 16).is_ok_and(|value| value > 0)
                        && Uuid::parse_str(uuid).is_ok()
                });
            if !valid {
                return Err("Invalid preview log resume cursor".into());
            }
        }
        Ok(Self {
            timestamp: timestamp.max(0),
            id: id.map(str::to_owned),
        })
    }
}

fn store_key(user_id: &str, port: u16) -> String {
    format!("{user_id}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_logs_after_cursor_returns_only_newer_entries() {
        let store = RequestLogStore::new();
        let port = 5173;
        let user_id = "user-1";

        store
            .add_log(
                user_id,
                port,
                ProxyLogInput {
                    timestamp: 10,
                    method: "GET".to_string(),
                    url: "/first".to_string(),
                    status: Some(200),
                    status_text: Some("OK".to_string()),
                    duration: 5,
                    request_size: None,
                    response_size: Some(10),
                    content_type: Some("text/html".to_string()),
                    error: None,
                },
            )
            .await;
        store
            .add_log(
                user_id,
                port,
                ProxyLogInput {
                    timestamp: 20,
                    method: "GET".to_string(),
                    url: "/second".to_string(),
                    status: Some(200),
                    status_text: Some("OK".to_string()),
                    duration: 5,
                    request_size: None,
                    response_size: Some(10),
                    content_type: Some("text/html".to_string()),
                    error: None,
                },
            )
            .await;

        let all = store.get_logs(user_id, port, None).await;
        let cursor = LogCursor {
            timestamp: all[0].timestamp,
            id: Some(all[0].id.clone()),
        };
        let after = store.get_logs_after_cursor(user_id, port, cursor).await;

        assert_eq!(after.len(), 1);
        assert_eq!(after[0].url, "/second");
    }
}

#[cfg(test)]
mod completion_regressions {
    use super::*;
    fn input(timestamp: i64, url: &str) -> ProxyLogInput {
        ProxyLogInput {
            timestamp,
            method: "GET".into(),
            url: url.into(),
            status: Some(200),
            status_text: None,
            duration: 10,
            request_size: None,
            response_size: None,
            content_type: None,
            error: None,
        }
    }
    #[tokio::test]
    async fn cursor_delivers_late_completions_once_and_preserves_start_time() {
        let logs = RequestLogStore::new();
        logs.add_log("own", 5173, input(20, "fast")).await;
        let first = logs.get_logs("own", 5173, None).await.remove(0);
        let cursor = LogCursor {
            timestamp: first.timestamp,
            id: Some(first.id.clone()),
        };
        logs.add_log("own", 5173, input(10, "slow")).await;
        logs.add_log("own", 5173, input(30, "control")).await;
        let after = logs.get_logs_after_cursor("own", 5173, cursor).await;
        assert_eq!(
            after
                .iter()
                .map(|e| (e.url.as_str(), e.timestamp))
                .collect::<Vec<_>>(),
            vec![("slow", 10), ("control", 30)]
        );
        let last = after.last().unwrap();
        assert!(logs
            .get_logs_after_cursor(
                "own",
                5173,
                LogCursor {
                    timestamp: last.timestamp,
                    id: Some(last.id.clone())
                }
            )
            .await
            .is_empty());
    }
}

#[cfg(test)]
mod retention_regressions {
    use super::*;
    #[tokio::test]
    async fn append_cursor_survives_eviction_clear_and_owner_activity() {
        let store = RequestLogStore::new();
        let input = || ProxyLogInput {
            timestamp: 1,
            method: "GET".into(),
            url: "same-start-time".into(),
            status: None,
            status_text: None,
            duration: 1,
            request_size: None,
            response_size: None,
            content_type: None,
            error: None,
        };
        store.add_log("owner", 5173, input()).await;
        let first = store.get_logs("owner", 5173, None).await.remove(0);
        let cursor = LogCursor {
            timestamp: first.timestamp,
            id: Some(first.id),
        };
        for _ in 0..MAX_LOGS_PER_PORT + 1 {
            store.add_log("owner", 5173, input()).await;
        }
        store.add_log("other", 5173, input()).await;
        let retained = store.get_logs_after_cursor("owner", 5173, cursor).await;
        assert_eq!(retained.len(), MAX_LOGS_PER_PORT);
        let last = retained.last().unwrap();
        let cursor = LogCursor {
            timestamp: last.timestamp,
            id: Some(last.id.clone()),
        };
        store.clear_logs("owner", 5173).await;
        store.add_log("owner", 5173, input()).await;
        assert_eq!(
            store
                .get_logs_after_cursor("owner", 5173, cursor)
                .await
                .len(),
            1
        );
    }
}

#[cfg(test)]
mod resume_membership_regressions {
    use super::*;
    #[tokio::test]
    async fn an_unrecognized_opaque_id_never_suppresses_current_scope_entries() {
        let store = RequestLogStore::new();
        let input = || ProxyLogInput {
            timestamp: 10,
            method: "GET".into(),
            url: "retained".into(),
            status: None,
            status_text: None,
            duration: 1,
            request_size: None,
            response_size: None,
            content_type: None,
            error: None,
        };
        store.add_log("owner", 5173, input()).await;
        store.add_log("foreign", 5173, input()).await;
        let own = store.get_logs("owner", 5173, None).await.remove(0);
        let foreign = store.get_logs("foreign", 5173, None).await.remove(0);
        for id in [
            foreign.id,
            format!("ffffffffffffffff-{}", Uuid::new_v4()),
            format!("0000000000000001-{}", Uuid::new_v4()),
        ] {
            let after = store
                .get_logs_after_cursor(
                    "owner",
                    5173,
                    LogCursor {
                        timestamp: 20,
                        id: Some(id),
                    },
                )
                .await;
            assert_eq!(
                after.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                vec![own.id.as_str()]
            );
        }
    }
}

#[cfg(test)]
mod resume_contract_tests {
    use super::*;
    fn input(timestamp: i64, url: &str) -> ProxyLogInput {
        ProxyLogInput {
            timestamp,
            method: "GET".into(),
            url: url.into(),
            status: None,
            status_text: None,
            duration: 1,
            request_size: None,
            response_size: None,
            content_type: None,
            error: None,
        }
    }
    #[test]
    fn resume_input_is_bounded_and_validated_without_trusting_ordinals() {
        let id = format!("0000000000000001-{}", Uuid::new_v4());
        assert_eq!(
            LogCursor::for_resume(-1, Some(&id)).unwrap().id.as_deref(),
            Some(id.as_str())
        );
        for bad in [
            "".into(),
            "not-an-id".into(),
            "a".repeat(100_000),
            format!("0000000000000000-{}", Uuid::new_v4()),
            "ffffffffffffffff-00000000-0000-0000-0000-not-a-uuid".into(),
        ] {
            assert!(LogCursor::for_resume(20, Some(&bad)).is_err());
        }
        assert!(LogCursor::for_resume(20, None).unwrap().id.is_none());
    }
    #[tokio::test]
    async fn reconnect_late_completion_clear_and_restart_have_bounded_current_history() {
        let store = RequestLogStore::new();
        store.add_log("owner", 5173, input(20, "fast")).await;
        let first = store.get_logs("owner", 5173, None).await.remove(0);
        let resume = LogCursor::for_resume(20, Some(&first.id)).unwrap();
        store.add_log("owner", 5173, input(10, "late")).await;
        assert_eq!(
            store
                .get_logs_after_cursor("owner", 5173, resume.clone())
                .await
                .iter()
                .map(|e| e.url.as_str())
                .collect::<Vec<_>>(),
            vec!["late"]
        );
        assert!(store
            .get_logs_after_cursor("owner", 5173, LogCursor::for_resume(20, None).unwrap())
            .await
            .is_empty());
        store.clear_logs("owner", 5173).await;
        store
            .add_log("owner", 5173, input(5, "in-flight-after-clear"))
            .await;
        assert_eq!(
            store
                .get_logs_after_cursor("owner", 5173, resume.clone())
                .await
                .iter()
                .map(|e| e.url.as_str())
                .collect::<Vec<_>>(),
            vec!["in-flight-after-clear"]
        );
        let restarted = RequestLogStore::new();
        restarted
            .add_log("owner", 5173, input(1, "new-runtime"))
            .await;
        assert_eq!(
            restarted
                .get_logs_after_cursor("owner", 5173, resume.clone())
                .await
                .iter()
                .map(|e| e.url.as_str())
                .collect::<Vec<_>>(),
            vec!["new-runtime"]
        );
        assert!(restarted
            .get_logs_after_cursor("other", 5173, resume)
            .await
            .is_empty());
    }
}
