use std::collections::HashMap;
use std::sync::Arc;

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
}

impl RequestLogStore {
    pub fn new() -> Self {
        Self {
            logs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_log(&self, user_id: &str, port: u16, input: ProxyLogInput) {
        let mut logs = self.logs.lock().await;
        let port_logs = logs.entry(store_key(user_id, port)).or_default();
        port_logs.push(ProxyLogEntry {
            id: Uuid::new_v4().to_string(),
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

        if cursor.timestamp <= 0 {
            return entries.clone();
        }

        let mut result = Vec::new();
        let mut matched_cursor = cursor.id.is_none();

        for entry in entries {
            if entry.timestamp < cursor.timestamp {
                continue;
            }
            if entry.timestamp > cursor.timestamp {
                result.push(entry.clone());
                continue;
            }
            if matched_cursor {
                result.push(entry.clone());
                continue;
            }
            if cursor.id.as_deref() == Some(entry.id.as_str()) {
                matched_cursor = true;
            }
        }

        if !matched_cursor && cursor.id.is_some() {
            return entries
                .iter()
                .filter(|entry| entry.timestamp >= cursor.timestamp)
                .cloned()
                .collect();
        }

        result
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
