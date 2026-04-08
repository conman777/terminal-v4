use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{broadcast, Mutex};

const MAX_METRICS_PER_TYPE: usize = 1_000;
const STREAM_BUFFER: usize = 32;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMetricEntry {
    #[serde(rename = "type")]
    pub metric_type: String,
    pub timestamp: i64,
    pub data: Value,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMetricsSnapshot {
    pub core_web_vitals: Vec<PerformanceMetricEntry>,
    pub load_metrics: Vec<PerformanceMetricEntry>,
    pub runtime_metrics: Vec<PerformanceMetricEntry>,
}

#[derive(Clone)]
pub struct PerformanceStore {
    metrics: Arc<Mutex<HashMap<String, PerformanceMetricsSnapshot>>>,
    streams: Arc<Mutex<HashMap<String, broadcast::Sender<PerformanceMetricsSnapshot>>>>,
}

impl PerformanceStore {
    pub fn new() -> Self {
        Self {
            metrics: Arc::new(Mutex::new(HashMap::new())),
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_metrics(
        &self,
        user_id: &str,
        port: u16,
        metrics: Vec<PerformanceMetricEntry>,
    ) -> Result<PerformanceMetricsSnapshot, String> {
        let mut snapshot_delta = PerformanceMetricsSnapshot::default();

        {
            let mut stored = self.metrics.lock().await;
            let snapshot = stored.entry(store_key(user_id, port)).or_default();

            for metric in metrics {
                match metric.metric_type.as_str() {
                    "coreWebVitals" => {
                        push_metric(&mut snapshot.core_web_vitals, metric.clone());
                        snapshot_delta.core_web_vitals.push(metric);
                    }
                    "loadMetrics" => {
                        push_metric(&mut snapshot.load_metrics, metric.clone());
                        snapshot_delta.load_metrics.push(metric);
                    }
                    "runtimeMetrics" => {
                        push_metric(&mut snapshot.runtime_metrics, metric.clone());
                        snapshot_delta.runtime_metrics.push(metric);
                    }
                    other => {
                        return Err(format!("Unsupported performance metric type: {other}"));
                    }
                }
            }
        }

        let sender = self.sender_for(user_id, port).await;
        let _ = sender.send(snapshot_delta.clone());
        Ok(snapshot_delta)
    }

    pub async fn get_metrics(&self, user_id: &str, port: u16) -> PerformanceMetricsSnapshot {
        let stored = self.metrics.lock().await;
        stored
            .get(&store_key(user_id, port))
            .cloned()
            .unwrap_or_default()
    }

    pub async fn clear_metrics(&self, user_id: &str, port: u16) {
        let mut stored = self.metrics.lock().await;
        stored.remove(&store_key(user_id, port));
    }

    pub async fn subscribe(
        &self,
        user_id: &str,
        port: u16,
    ) -> broadcast::Receiver<PerformanceMetricsSnapshot> {
        self.sender_for(user_id, port).await.subscribe()
    }

    async fn sender_for(
        &self,
        user_id: &str,
        port: u16,
    ) -> broadcast::Sender<PerformanceMetricsSnapshot> {
        let mut streams = self.streams.lock().await;
        streams
            .entry(store_key(user_id, port))
            .or_insert_with(|| broadcast::channel(STREAM_BUFFER).0)
            .clone()
    }
}

fn push_metric(entries: &mut Vec<PerformanceMetricEntry>, metric: PerformanceMetricEntry) {
    entries.push(metric);
    if entries.len() > MAX_METRICS_PER_TYPE {
        let overflow = entries.len() - MAX_METRICS_PER_TYPE;
        entries.drain(0..overflow);
    }
}

fn store_key(user_id: &str, port: u16) -> String {
    format!("{user_id}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn add_metrics_groups_entries_by_type() {
        let store = PerformanceStore::new();
        let user_id = "user-1";
        let port = 5173;

        store
            .add_metrics(
                user_id,
                port,
                vec![
                    PerformanceMetricEntry {
                        metric_type: "coreWebVitals".to_string(),
                        timestamp: 1,
                        data: json!({ "lcp": 1200 }),
                    },
                    PerformanceMetricEntry {
                        metric_type: "runtimeMetrics".to_string(),
                        timestamp: 2,
                        data: json!({ "fps": 60 }),
                    },
                ],
            )
            .await
            .expect("metrics should be stored");

        let snapshot = store.get_metrics(user_id, port).await;
        assert_eq!(snapshot.core_web_vitals.len(), 1);
        assert_eq!(snapshot.load_metrics.len(), 0);
        assert_eq!(snapshot.runtime_metrics.len(), 1);
    }

    #[tokio::test]
    async fn add_metrics_rejects_unknown_metric_types() {
        let store = PerformanceStore::new();
        let result = store
            .add_metrics(
                "user-1",
                5173,
                vec![PerformanceMetricEntry {
                    metric_type: "mystery".to_string(),
                    timestamp: 1,
                    data: json!({}),
                }],
            )
            .await;

        assert_eq!(
            result.expect_err("unknown types should fail"),
            "Unsupported performance metric type: mystery"
        );
    }
}
