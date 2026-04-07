use std::path::PathBuf;
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub memory_percent: f32,
    pub disk_used: u64,
    pub disk_total: u64,
    pub disk_percent: f32,
    pub uptime: u64,
    pub timestamp: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub disk_percent: f32,
    pub timestamp: i64,
}

pub struct SystemStatsCollector {
    sys: Arc<Mutex<System>>,
    history: Arc<Mutex<Vec<StatsSnapshot>>>,
    history_path: PathBuf,
}

impl SystemStatsCollector {
    pub fn new() -> Self {
        let history_path = dirs_home().join(".terminal-v4-stats-history.json");
        let history = load_history(&history_path);

        Self {
            sys: Arc::new(Mutex::new(System::new_all())),
            history: Arc::new(Mutex::new(history)),
            history_path,
        }
    }

    /// Get current system stats.
    pub async fn get_current(&self) -> SystemStats {
        let mut sys = self.sys.lock().await;
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let cpu_percent = sys.global_cpu_usage();
        let memory_used = sys.used_memory();
        let memory_total = sys.total_memory();
        let memory_percent = if memory_total > 0 {
            (memory_used as f32 / memory_total as f32) * 100.0
        } else {
            0.0
        };

        let disks = sysinfo::Disks::new_with_refreshed_list();
        let (disk_used, disk_total) = disks.iter().fold((0u64, 0u64), |(used, total), disk| {
            (
                used + (disk.total_space() - disk.available_space()),
                total + disk.total_space(),
            )
        });
        let disk_percent = if disk_total > 0 {
            (disk_used as f32 / disk_total as f32) * 100.0
        } else {
            0.0
        };

        SystemStats {
            cpu_percent,
            memory_used,
            memory_total,
            memory_percent,
            disk_used,
            disk_total,
            disk_percent,
            uptime: System::uptime(),
            timestamp: now_millis(),
        }
    }

    /// Record a snapshot to history.
    pub async fn record_snapshot(&self) {
        let stats = self.get_current().await;
        let snapshot = StatsSnapshot {
            cpu_percent: stats.cpu_percent,
            memory_percent: stats.memory_percent,
            disk_percent: stats.disk_percent,
            timestamp: stats.timestamp,
        };

        let mut history = self.history.lock().await;
        history.push(snapshot);

        // Prune older than 30 days
        let cutoff = now_millis() - (30 * 24 * 60 * 60 * 1000);
        history.retain(|s| s.timestamp > cutoff);

        // Persist
        if let Ok(json) = serde_json::to_string_pretty(&*history) {
            let _ = std::fs::write(&self.history_path, json);
        }
    }

    /// Get history within a time range.
    pub async fn get_history(&self, range: &str) -> Vec<StatsSnapshot> {
        let cutoff_ms = match range {
            "1h" => 60 * 60 * 1000,
            "6h" => 6 * 60 * 60 * 1000,
            "24h" => 24 * 60 * 60 * 1000,
            "7d" => 7 * 24 * 60 * 60 * 1000,
            "30d" => 30 * 24 * 60 * 60 * 1000,
            _ => 24 * 60 * 60 * 1000,
        };
        let cutoff = now_millis() - cutoff_ms;
        let history = self.history.lock().await;
        history
            .iter()
            .filter(|s| s.timestamp > cutoff)
            .cloned()
            .collect()
    }

    /// Start background collection every 5 minutes.
    pub fn start_background_collection(self: &Arc<Self>) {
        let collector = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                collector.record_snapshot().await;
            }
        });
    }
}

fn load_history(path: &PathBuf) -> Vec<StatsSnapshot> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}
