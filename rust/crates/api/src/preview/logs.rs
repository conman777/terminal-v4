use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

const MAX_LOGS_PER_PORT: usize = 500;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLogEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub log_type: String,
    pub level: String,
    pub message: String,
    pub timestamp: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

type LogsByOwnerPort = HashMap<(String, u16), Vec<PreviewLogEntry>>;

#[derive(Clone)]
pub struct PreviewLogStore {
    logs: Arc<Mutex<LogsByOwnerPort>>,
    websockets: super::ws_logs::WebSocketLogStore,
}

impl PreviewLogStore {
    pub fn new() -> Self {
        Self {
            logs: Arc::new(Mutex::new(HashMap::new())),
            websockets: Default::default(),
        }
    }

    pub fn websockets(&self) -> super::ws_logs::WebSocketLogStore {
        self.websockets.clone()
    }

    /// Ingest a log entry for a port.
    pub async fn add_log(&self, owner: &str, port: u16, entry: PreviewLogEntry) {
        let mut logs = self.logs.lock().await;
        let port_logs = logs.entry((owner.into(), port)).or_default();
        port_logs.push(entry);
        if port_logs.len() > MAX_LOGS_PER_PORT {
            port_logs.remove(0);
        }
    }

    /// Get logs for a port, optionally filtered.
    pub async fn get_logs(
        &self,
        owner: &str,
        port: u16,
        log_type: Option<&str>,
        level: Option<&str>,
        since: Option<i64>,
        limit: Option<usize>,
    ) -> Vec<PreviewLogEntry> {
        let logs = self.logs.lock().await;
        let Some(port_logs) = logs.get(&(owner.into(), port)) else {
            return Vec::new();
        };

        let mut filtered: Vec<&PreviewLogEntry> = port_logs
            .iter()
            .filter(|log| {
                if let Some(t) = log_type {
                    if log.log_type != t {
                        return false;
                    }
                }
                if let Some(l) = level {
                    if log.level != l {
                        return false;
                    }
                }
                if let Some(s) = since {
                    if log.timestamp <= s {
                        return false;
                    }
                }
                true
            })
            .collect();

        let limit = limit.unwrap_or(100).min(500);
        if filtered.len() > limit {
            filtered = filtered[filtered.len() - limit..].to_vec();
        }

        filtered.into_iter().cloned().collect()
    }

    /// Clear logs for a port.
    pub async fn clear_logs(&self, owner: &str, port: u16) {
        let mut logs = self.logs.lock().await;
        logs.remove(&(owner.into(), port));
    }

    /// List all ports that have logs.
    pub async fn active_ports(&self, owner: &str) -> Vec<(u16, usize)> {
        let logs = self.logs.lock().await;
        logs.iter()
            .filter(|((user, _), _)| user == owner)
            .map(|((_, port), entries)| (*port, entries.len()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn owner_isolates_read_clear_and_port_discovery() {
        let store = PreviewLogStore::new();
        let entry = PreviewLogEntry {
            id: "a".into(),
            log_type: "console".into(),
            level: "log".into(),
            message: "owner-a".into(),
            timestamp: 1,
            extra: HashMap::new(),
        };
        store.add_log("a", 5173, entry).await;
        assert!(store
            .get_logs("b", 5173, None, None, None, None)
            .await
            .is_empty());
        assert!(store.active_ports("b").await.is_empty());
        store.clear_logs("b", 5173).await;
        assert_eq!(
            store
                .get_logs("a", 5173, None, None, None, None)
                .await
                .iter()
                .map(|entry| entry.message.as_str())
                .collect::<Vec<_>>(),
            vec!["owner-a"]
        );
        assert_eq!(store.active_ports("a").await, vec![(5173, 1)]);
        store.clear_logs("a", 5173).await;
        assert!(store
            .get_logs("a", 5173, None, None, None, None)
            .await
            .is_empty());
    }
}
