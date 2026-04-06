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

#[derive(Clone)]
pub struct PreviewLogStore {
    logs: Arc<Mutex<HashMap<u16, Vec<PreviewLogEntry>>>>,
}

impl PreviewLogStore {
    pub fn new() -> Self {
        Self {
            logs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Ingest a log entry for a port.
    pub async fn add_log(&self, port: u16, entry: PreviewLogEntry) {
        let mut logs = self.logs.lock().await;
        let port_logs = logs.entry(port).or_default();
        port_logs.push(entry);
        if port_logs.len() > MAX_LOGS_PER_PORT {
            port_logs.remove(0);
        }
    }

    /// Get logs for a port, optionally filtered.
    pub async fn get_logs(
        &self,
        port: u16,
        log_type: Option<&str>,
        level: Option<&str>,
        since: Option<i64>,
        limit: Option<usize>,
    ) -> Vec<PreviewLogEntry> {
        let logs = self.logs.lock().await;
        let Some(port_logs) = logs.get(&port) else {
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
    pub async fn clear_logs(&self, port: u16) {
        let mut logs = self.logs.lock().await;
        logs.remove(&port);
    }

    /// List all ports that have logs.
    pub async fn active_ports(&self) -> Vec<(u16, usize)> {
        let logs = self.logs.lock().await;
        logs.iter()
            .map(|(port, entries)| (*port, entries.len()))
            .collect()
    }
}
