use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const MAX_SCOPES: usize = 32;
const MAX_CONNECTIONS: usize = 50;
const MAX_MESSAGES: usize = 500;
const MAX_DATA_BYTES: usize = 4096;

#[derive(Clone, Default)]
pub struct WebSocketLogStore(Arc<Mutex<HashMap<(String, u16), Scope>>>);

#[derive(Default)]
struct Scope {
    connections: VecDeque<Connection>,
    messages: VecDeque<Message>,
    touched: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: String,
    url: String,
    status: String,
    timestamp: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    id: String,
    connection_id: String,
    direction: String,
    format: String,
    data: String,
    size: usize,
    truncated: bool,
    timestamp: i64,
}

#[derive(Serialize)]
pub struct Snapshot {
    connections: Vec<Connection>,
    messages: Vec<Message>,
}

pub struct ConnectionLog {
    store: WebSocketLogStore,
    owner: String,
    port: u16,
    id: String,
}

impl WebSocketLogStore {
    pub fn open(&self, owner: &str, port: u16, path: &str) -> ConnectionLog {
        let id = Uuid::new_v4().to_string();
        let mut scopes = self.0.lock().unwrap();
        let key = (owner.to_owned(), port);
        if !scopes.contains_key(&key) && scopes.len() >= MAX_SCOPES {
            if let Some(oldest) = scopes
                .iter()
                .min_by_key(|(_, scope)| scope.touched)
                .map(|(key, _)| key.clone())
            {
                scopes.remove(&oldest);
            }
        }
        let scope = scopes.entry(key).or_default();
        scope.touched = now();
        let path = path.split(['?', '#']).next().unwrap_or("/");
        let safe_path: String = path
            .chars()
            .filter(|ch| !ch.is_control())
            .take(1024)
            .collect();
        scope.connections.push_back(Connection {
            id: id.clone(),
            url: format!("ws://localhost:{port}{safe_path}"),
            status: "connecting".into(),
            timestamp: now(),
        });
        if scope.connections.len() > MAX_CONNECTIONS {
            if let Some(expired) = scope.connections.pop_front() {
                scope
                    .messages
                    .retain(|message| message.connection_id != expired.id);
            }
        }
        ConnectionLog {
            store: self.clone(),
            owner: owner.into(),
            port,
            id,
        }
    }

    pub fn snapshot(
        &self,
        owner: &str,
        port: u16,
        connection_id: Option<&str>,
        direction: Option<&str>,
    ) -> Snapshot {
        let scopes = self.0.lock().unwrap();
        let Some(scope) = scopes.get(&(owner.into(), port)) else {
            return Snapshot {
                connections: vec![],
                messages: vec![],
            };
        };
        Snapshot {
            connections: scope.connections.iter().cloned().collect(),
            messages: scope
                .messages
                .iter()
                .filter(|message| {
                    connection_id.is_none_or(|id| id == message.connection_id)
                        && direction.is_none_or(|direction| direction == message.direction)
                })
                .cloned()
                .collect(),
        }
    }

    pub fn clear(&self, owner: &str, port: u16) {
        let mut scopes = self.0.lock().unwrap();
        if let Some(scope) = scopes.get_mut(&(owner.into(), port)) {
            scope.messages.clear();
            scope.connections.retain(|connection| {
                matches!(connection.status.as_str(), "connecting" | "connected")
            });
            if scope.connections.is_empty() {
                scopes.remove(&(owner.into(), port));
            }
        }
    }
}

impl ConnectionLog {
    pub fn status(&self, status: &str) {
        let mut scopes = self.store.0.lock().unwrap();
        if let Some(scope) = scopes.get_mut(&(self.owner.clone(), self.port)) {
            if let Some(connection) = scope
                .connections
                .iter_mut()
                .find(|connection| connection.id == self.id)
            {
                if status != "closed" || connection.status != "error" {
                    connection.status = status.into();
                }
                scope.touched = now();
            }
        }
    }

    pub fn message(&self, direction: &str, data: &[u8], binary: bool) {
        let mut scopes = self.store.0.lock().unwrap();
        let Some(scope) = scopes.get_mut(&(self.owner.clone(), self.port)) else {
            return;
        };
        if !scope
            .connections
            .iter()
            .any(|connection| connection.id == self.id)
        {
            return;
        }
        // Binary content is represented as bounded hex rather than expanded lossy text.
        let size = data.len();
        let (data, truncated) = if binary {
            (
                hex::encode(&data[..data.len().min(MAX_DATA_BYTES / 2)]),
                data.len() > MAX_DATA_BYTES / 2,
            )
        } else {
            let text = String::from_utf8_lossy(data);
            let mut end = text.len().min(MAX_DATA_BYTES);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            (text[..end].into(), end < text.len())
        };
        scope.messages.push_back(Message {
            id: Uuid::new_v4().to_string(),
            connection_id: self.id.clone(),
            direction: direction.into(),
            format: if binary { "binary" } else { "text" }.into(),
            data,
            size,
            truncated,
            timestamp: now(),
        });
        if scope.messages.len() > MAX_MESSAGES {
            scope.messages.pop_front();
        }
        scope.touched = now();
    }
}

impl Drop for ConnectionLog {
    fn drop(&mut self) {
        self.status("closed");
    }
}

fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clear_retains_live_connection_and_resumes_messages() {
        let store = WebSocketLogStore::default();
        let log = store.open("a", 5173, "/hmr");
        log.status("connected");
        log.message("sent", b"before", false);
        store.clear("a", 5173);
        log.message("sent", b"after", false);
        assert_eq!(
            store
                .snapshot("a", 5173, None, None)
                .messages
                .iter()
                .map(|message| message.data.as_str())
                .collect::<Vec<_>>(),
            vec!["after"]
        );
    }

    #[test]
    fn scope_filters_bounds_redaction_and_close_are_observable() {
        let store = WebSocketLogStore::default();
        let log = store.open("a", 5173, "/hmr?token=do-not-retain#secret");
        log.status("connected");
        log.message("sent", b"hello", false);
        log.message("received", "é".repeat(5000).as_bytes(), false);
        let value = serde_json::to_value(store.snapshot("a", 5173, None, None)).unwrap();
        assert_eq!(value["connections"][0]["url"], "ws://localhost:5173/hmr");
        assert_eq!(
            value["messages"][1]["data"].as_str().unwrap().len(),
            MAX_DATA_BYTES
        );
        assert_eq!(value["messages"][1]["truncated"], true);
        assert!(store.snapshot("b", 5173, None, None).connections.is_empty());
        store.clear("b", 5173);
        assert_eq!(
            store
                .snapshot("a", 5173, Some(&log.id), Some("sent"))
                .messages
                .len(),
            1
        );
        assert!(store.snapshot("a", 5174, None, None).connections.is_empty());
        for _ in 0..600 {
            log.message("sent", b"new", false);
        }
        assert_eq!(
            store.snapshot("a", 5173, None, None).messages.len(),
            MAX_MESSAGES
        );
        drop(log);
        assert_eq!(
            store.snapshot("a", 5173, None, None).connections[0].status,
            "closed"
        );
        for _ in 0..60 {
            drop(store.open("a", 5173, "/"));
        }
        assert_eq!(
            store.snapshot("a", 5173, None, None).connections.len(),
            MAX_CONNECTIONS
        );
        store.clear("a", 5173);
        assert!(store.snapshot("a", 5173, None, None).messages.is_empty());
    }
}
