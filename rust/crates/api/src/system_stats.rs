use std::path::{Path, PathBuf};
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::Mutex;

const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024;

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
    pub cpu: CpuInfo,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub processes: Vec<ProcessStat>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CpuInfo {
    pub cores: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStat {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub memory_bytes: u64,
}

const TOP_PROCESSES: usize = 8;

/// The busiest processes first, by CPU and then memory.
fn top_processes(mut processes: Vec<ProcessStat>, limit: usize) -> Vec<ProcessStat> {
    processes.sort_by(|a, b| {
        b.cpu
            .total_cmp(&a.cpu)
            .then(b.memory_bytes.cmp(&a.memory_bytes))
    });
    processes.truncate(limit);
    processes
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub disk_percent: f32,
    pub timestamp: i64,
}

pub struct HistoryPersistenceHealth {
    pub error: Option<String>,
    pub persistence_enabled: bool,
}

struct HistoryPersistenceState {
    notice: Option<String>,
    writes_allowed: bool,
    write_error: Option<String>,
}

pub struct SystemStatsCollector {
    sys: Arc<Mutex<System>>,
    history: Arc<Mutex<Vec<StatsSnapshot>>>,
    history_path: PathBuf,
    persistence: std::sync::Mutex<HistoryPersistenceState>,
    worker: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SystemStatsCollector {
    pub fn new(data_dir: &Path) -> Self {
        let history_path = data_dir.join("stats-history.json");
        let (history, history_error, history_persistence_enabled) =
            match load_history(&history_path) {
                Ok((history, warning)) => (history, warning, true),
                Err(error) => (
                    Vec::new(),
                    Some(format!("Statistics history persistence disabled: {error}")),
                    false,
                ),
            };
        if let Some(error) = &history_error {
            tracing::warn!(%error, "System statistics history requires attention");
        }

        Self {
            sys: Arc::new(Mutex::new(System::new_all())),
            history: Arc::new(Mutex::new(history)),
            history_path,
            persistence: std::sync::Mutex::new(HistoryPersistenceState {
                notice: history_error,
                writes_allowed: history_persistence_enabled,
                write_error: None,
            }),
            worker: std::sync::Mutex::new(None),
        }
    }

    pub fn history_health(&self) -> HistoryPersistenceHealth {
        let state = self
            .persistence
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let error = match (&state.notice, &state.write_error) {
            (Some(notice), Some(error)) => Some(format!("{notice}; {error}")),
            (notice, error) => error.as_ref().or(notice.as_ref()).cloned(),
        };
        HistoryPersistenceHealth {
            error,
            persistence_enabled: state.writes_allowed && state.write_error.is_none(),
        }
    }

    pub fn history_error(&self) -> Option<String> {
        self.history_health().error
    }

    pub fn history_persistence_enabled(&self) -> bool {
        self.history_health().persistence_enabled
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
            cpu: CpuInfo {
                cores: sys.cpus().len(),
            },
            processes: Vec::new(),
        }
    }

    /// Current stats plus the busiest processes, for the System Resources view.
    pub async fn get_current_with_processes(&self) -> SystemStats {
        let mut stats = self.get_current().await;
        let mut sys = self.sys.lock().await;
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let processes = sys
            .processes()
            .iter()
            .map(|(pid, process)| ProcessStat {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
                cpu: process.cpu_usage(),
                memory_bytes: process.memory(),
            })
            .collect();
        stats.processes = top_processes(processes, TOP_PROCESSES);
        stats
    }

    /// Record a snapshot to history.
    pub async fn record_snapshot(&self) -> Result<(), String> {
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

        let mut persistence = self
            .persistence
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !persistence.writes_allowed {
            return Err(persistence
                .notice
                .clone()
                .unwrap_or_else(|| "Statistics history persistence disabled".into()));
        }
        // Retry transient writes on the next sample; only a completed save clears degradation.
        let result = persist_history(&self.history_path, &history);
        persistence.write_error = result.as_ref().err().map(|error| {
            format!("Statistics history is temporary until a successful save: {error}")
        });
        result
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

    /// Start one runtime-owned collector, including an initial sample.
    pub fn start_background_collection(self: &Arc<Self>) {
        self.start_collection(std::time::Duration::from_secs(300));
    }

    fn start_collection(self: &Arc<Self>, period: std::time::Duration) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if worker.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let collector = Arc::downgrade(self);
        *worker = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(collector) = collector.upgrade() else {
                    break;
                };
                if let Err(error) = collector.record_snapshot().await {
                    tracing::warn!(%error, "System statistics could not be persisted");
                }
            }
        }));
    }

    pub async fn shutdown(&self) {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(worker) = worker {
            worker.abort();
            let _ = worker.await;
        }
    }
}

impl Drop for SystemStatsCollector {
    fn drop(&mut self) {
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            worker.abort();
        }
    }
}

fn load_history(path: &Path) -> Result<(Vec<StatsSnapshot>, Option<String>), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err("History is not a regular file; original left untouched".into())
        }
        Ok(metadata) if metadata.len() > MAX_HISTORY_BYTES => {
            return Err("History exceeds the 8 MiB recovery limit; original left untouched".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), None))
        }
        Err(error) => return Err(error.to_string()),
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_HISTORY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_HISTORY_BYTES {
        return Err("History exceeds the 8 MiB recovery limit; original left untouched".into());
    }
    match serde_json::from_slice(&bytes) {
        Ok(history) => Ok((history, None)),
        Err(error) => {
            preserve_corrupt_history(path, &bytes)?;
            persist_history(path, &[])?;
            Ok((Vec::new(), Some(format!("Invalid statistics history ({error}) preserved as stats-history.corrupt.json; fresh history initialized"))))
        }
    }
}

fn preserve_corrupt_history(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Missing stats data directory")?;
    let quarantine = parent.join("stats-history.corrupt.json");
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    // One no-clobber recovery slot bounds automatic recovery and retains previous evidence.
    temporary
        .persist_noclobber(&quarantine)
        .map_err(|error| format!("Cannot preserve history recovery file: {error}"))?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot confirm history recovery durability: {error}"))?;
    if std::fs::read(&quarantine).map_err(|error| error.to_string())? != bytes {
        return Err(
            "History recovery bytes could not be confirmed; original left untouched".into(),
        );
    }
    if std::fs::read(path).map_err(|error| error.to_string())? != bytes {
        return Err("History changed during recovery; original left untouched".into());
    }
    Ok(())
}

fn persist_history(path: &Path, history: &[StatsSnapshot]) -> Result<(), String> {
    use std::io::Write;
    let json = serde_json::to_vec_pretty(history).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Missing stats data directory")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(&json)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn now_millis() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .expect("timestamp should fit in i64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn top_processes_lists_the_busiest_first() {
        let process = |pid, cpu, memory_bytes| ProcessStat {
            pid,
            name: format!("p{pid}"),
            cpu,
            memory_bytes,
        };
        let top = top_processes(
            vec![
                process(1, 2.0, 10),
                process(2, 40.0, 5),
                process(3, 2.0, 90),
                process(4, 0.0, 1),
            ],
            3,
        );
        assert_eq!(top.iter().map(|p| p.pid).collect::<Vec<_>>(), [2, 3, 1]);
    }

    #[tokio::test]
    async fn current_stats_report_cores_and_processes() {
        let data = tempfile::tempdir().unwrap();
        let stats = SystemStatsCollector::new(data.path())
            .get_current_with_processes()
            .await;
        assert!(
            stats.cpu.cores > 0
                && !stats.processes.is_empty()
                && stats.processes.len() <= TOP_PROCESSES
        );
    }

    #[tokio::test]
    async fn collector_records_persists_and_stops_in_runtime_data_root() {
        let data = tempfile::tempdir().unwrap();
        let collector = Arc::new(SystemStatsCollector::new(data.path()));
        collector.start_collection(Duration::from_millis(20));
        collector.start_collection(Duration::from_millis(20));
        tokio::time::timeout(Duration::from_secs(3), async {
            while collector.get_history("1h").await.len() < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        collector.shutdown().await;
        let history = collector.get_history("1h").await;
        tokio::time::sleep(Duration::from_millis(60)).await;
        let reopened = SystemStatsCollector::new(data.path());
        assert_eq!(
            serde_json::to_value(collector.get_history("1h").await).unwrap(),
            serde_json::to_value(&history).unwrap()
        );
        assert_eq!(
            serde_json::to_value(reopened.get_history("1h").await).unwrap(),
            serde_json::to_value(history).unwrap()
        );
        assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn dropping_owner_releases_background_collector() {
        let data = tempfile::tempdir().unwrap();
        let collector = Arc::new(SystemStatsCollector::new(data.path()));
        let weak = Arc::downgrade(&collector);
        collector.start_background_collection();
        tokio::time::timeout(Duration::from_secs(3), async {
            while collector.get_history("1h").await.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        drop(collector);
        tokio::task::yield_now().await;
        assert!(weak.upgrade().is_none());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[tokio::test]
    async fn stats_recovery_preserves_exact_corrupt_bytes_then_collects_across_restart() {
        let cases: &[&[u8]] = &[
            br#"[{"cpuPercent":12"#,
            b"\xff\xfe synthetic corrupt history",
            br#"{"wrong":"schema"}"#,
            b"",
        ];
        for original in cases {
            let data = tempfile::tempdir().unwrap();
            let path = data.path().join("stats-history.json");
            let recovery = data.path().join("stats-history.corrupt.json");
            std::fs::write(&path, original).unwrap();
            let collector = SystemStatsCollector::new(data.path());
            assert!(collector.history_persistence_enabled());
            assert!(collector.history_error().unwrap().contains("preserved"));
            assert_eq!(std::fs::read(&recovery).unwrap(), *original);
            assert_eq!(std::fs::read(&path).unwrap(), b"[]");
            collector.record_snapshot().await.unwrap();
            let expected = collector.get_history("1h").await;
            drop(collector);
            for _ in 0..3 {
                let reopened = SystemStatsCollector::new(data.path());
                assert!(reopened.history_error().is_none());
                assert_eq!(
                    serde_json::to_value(reopened.get_history("1h").await).unwrap(),
                    serde_json::to_value(&expected).unwrap()
                );
                assert_eq!(std::fs::read(&recovery).unwrap(), *original);
            }
            assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 2);
        }
    }

    #[tokio::test]
    async fn stats_recovery_existing_backup_blocks_disk_writes_but_current_and_memory_stats_work() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("stats-history.json");
        let recovery = data.path().join("stats-history.corrupt.json");
        let original = b"synthetic newly corrupt history";
        let previous = b"synthetic earlier recovery evidence";
        std::fs::write(&path, original).unwrap();
        std::fs::write(&recovery, previous).unwrap();
        for _ in 0..3 {
            let collector = SystemStatsCollector::new(data.path());
            assert!(!collector.history_persistence_enabled());
            assert!(collector.history_error().unwrap().contains("disabled"));
            assert!(collector.get_current().await.timestamp > 0);
            assert!(collector.record_snapshot().await.is_err());
            assert_eq!(collector.get_history("1h").await.len(), 1);
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(std::fs::read(&recovery).unwrap(), previous);
            assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 2);
        }
        std::fs::write(&path, b"[]").unwrap();
        let repaired = SystemStatsCollector::new(data.path());
        assert!(repaired.history_error().is_none());
        repaired.record_snapshot().await.unwrap();
        assert_eq!(std::fs::read(&recovery).unwrap(), previous);
    }

    #[tokio::test]
    async fn stats_recovery_unreadable_nonfile_is_preserved_without_blocking_stats() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("stats-history.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("synthetic-preserve-marker"), b"recovery bytes").unwrap();
        let collector = SystemStatsCollector::new(data.path());
        assert!(!collector.history_persistence_enabled());
        assert!(collector
            .history_error()
            .unwrap()
            .contains("not a regular file"));
        assert!(collector.record_snapshot().await.is_err());
        assert_eq!(
            std::fs::read(path.join("synthetic-preserve-marker")).unwrap(),
            b"recovery bytes"
        );
        assert!(!data.path().join("stats-history.corrupt.json").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stats_recovery_permission_failure_preserves_original_and_restart_can_recover() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("stats-history.json");
        let original = b"synthetic history needing recovery";
        std::fs::write(&path, original).unwrap();
        std::fs::set_permissions(data.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let collector = SystemStatsCollector::new(data.path());
        let disabled = !collector.history_persistence_enabled();
        let record_failed = collector.record_snapshot().await.is_err();
        let preserved = std::fs::read(&path).unwrap();
        std::fs::set_permissions(data.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            disabled && record_failed,
            "Permission control must deny recovery writes on this host"
        );
        assert_eq!(preserved, original);
        let reopened = SystemStatsCollector::new(data.path());
        assert!(reopened.history_persistence_enabled());
        reopened.record_snapshot().await.unwrap();
        assert_eq!(
            std::fs::read(data.path().join("stats-history.corrupt.json")).unwrap(),
            original
        );
    }

    #[test]
    fn stats_recovery_read_permission_and_size_limits_leave_source_untouched() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("stats-history.json");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_HISTORY_BYTES + 1).unwrap();
        let collector = SystemStatsCollector::new(data.path());
        assert!(!collector.history_persistence_enabled());
        assert!(collector.history_error().unwrap().contains("8 MiB"));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 8 * 1024 * 1024 + 1);
        assert!(!data.path().join("stats-history.corrupt.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, b"synthetic unreadable corrupt history").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
            let unreadable = SystemStatsCollector::new(data.path());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(!unreadable.history_persistence_enabled());
            assert!(unreadable.history_error().is_some());
            assert_eq!(
                std::fs::read(&path).unwrap(),
                b"synthetic unreadable corrupt history"
            );
        }
    }
}

#[cfg(all(test, unix))]
mod write_health_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn stats_write_failure_reports_temporary_health_and_retry_preserves_recovery_notice() {
        for recovered in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let path = data.path().join("stats-history.json");
            let initial: &[u8] = if recovered {
                b"synthetic corrupt history"
            } else {
                b"[]"
            };
            std::fs::write(&path, initial).unwrap();
            let collector = SystemStatsCollector::new(data.path());
            let recovery_notice = collector.history_error();
            collector.record_snapshot().await.unwrap();
            let saved = std::fs::read(&path).unwrap();
            std::fs::set_permissions(data.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
            let failed = collector.record_snapshot().await;
            let enabled = collector.history_persistence_enabled();
            let error = collector.history_error();
            let memory_len = collector.get_history("1h").await.len();
            let unchanged = std::fs::read(&path).unwrap();
            std::fs::set_permissions(data.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(
                failed.is_err(),
                "Synthetic write-denial control must fail on this host"
            );
            assert!(
                !enabled,
                "Failed disk writes must report temporary persistence health"
            );
            assert!(error.unwrap().contains("temporary"));
            assert_eq!((memory_len, unchanged), (2, saved));
            assert_eq!(
                SystemStatsCollector::new(data.path())
                    .get_history("1h")
                    .await
                    .len(),
                1
            );
            collector.record_snapshot().await.unwrap();
            assert!(collector.history_persistence_enabled());
            assert_eq!(collector.history_error(), recovery_notice);
            assert_eq!(
                SystemStatsCollector::new(data.path())
                    .get_history("1h")
                    .await
                    .len(),
                3
            );
            if recovered {
                assert_eq!(
                    std::fs::read(data.path().join("stats-history.corrupt.json")).unwrap(),
                    initial
                );
            }
        }
    }
}
