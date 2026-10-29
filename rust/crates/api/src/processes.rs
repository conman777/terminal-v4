use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_LOGS_PER_PROCESS: usize = 1000;
const MAX_LOG_ENTRY_BYTES: usize = 50 * 1024;
const EXIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub port: Option<u16>,
    pub started_at: String,
    pub exited_at: Option<String>,
    pub exit_code: Option<i32>,
    pub running: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogEntry {
    pub id: String,
    pub timestamp: i64,
    pub stream: String,
    pub data: String,
}

#[derive(Debug, Clone, Default)]
pub struct LogCursor {
    pub timestamp: i64,
    pub id: Option<String>,
}

#[derive(Clone)]
pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<u32, ManagedProcess>>>,
}

struct ManagedProcess {
    info: ProcessInfo,
    logs: Vec<ProcessLogEntry>,
    child: Option<tokio::process::Child>,
    tree: Option<crate::process_tree::ProcessTree>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Start a process in the given directory.
    pub async fn start(
        &self,
        cwd: &str,
        command: &str,
        args: &[&str],
    ) -> Result<ProcessInfo, String> {
        let mut process_command = Command::new(command);
        process_command
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process_command.process_group(0);
        let mut child = process_command
            .spawn()
            .map_err(|e| format!("Failed to start process: {e}"))?;

        let pid = child.id().ok_or("Process has no PID")?;
        #[cfg(unix)]
        let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child)
            .map_err(|e| format!("Failed to track process tree: {e}"))?;
        #[cfg(not(unix))]
        let tree = crate::process_tree::ProcessTree::attach(&child)
            .map_err(|e| format!("Failed to track process tree: {e}"))?;
        let now = iso_timestamp();

        let info = ProcessInfo {
            pid,
            command: format!("{command} {}", args.join(" ")),
            cwd: cwd.to_string(),
            port: None,
            started_at: now,
            exited_at: None,
            exit_code: None,
            running: true,
        };

        // Spawn stdout/stderr readers
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let processes = self.processes.clone();

        if let Some(stdout) = stdout {
            let processes = processes.clone();
            tokio::spawn(async move {
                read_stream(processes, pid, "stdout", stdout).await;
            });
        }

        if let Some(stderr) = stderr {
            let processes = processes.clone();
            tokio::spawn(async move {
                read_stream(processes, pid, "stderr", stderr).await;
            });
        }

        // Spawn exit watcher
        let processes_exit = self.processes.clone();
        let managed = ManagedProcess {
            info: info.clone(),
            logs: Vec::new(),
            child: Some(child),
            tree: Some(tree),
        };

        {
            let mut procs = self.processes.lock().await;
            procs.insert(pid, managed);
        }

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(EXIT_POLL_INTERVAL).await;

                let mut done = false;
                let mut procs = processes_exit.lock().await;
                if let Some(proc) = procs.get_mut(&pid) {
                    if !proc.info.running {
                        done = true;
                    } else if let Some(ref mut child) = proc.child {
                        let status = match &proc.tree {
                            Some(tree) => tree.try_wait(child),
                            None => child.try_wait(),
                        };
                        match status {
                            Ok(Some(status)) => {
                                proc.info.running = false;
                                proc.info.exit_code = status.code();
                                proc.info.exited_at = Some(iso_timestamp());
                                done = true;
                            }
                            Ok(None) => {}
                            Err(_) => {
                                proc.info.running = false;
                                proc.info.exited_at = Some(iso_timestamp());
                                done = true;
                            }
                        }
                    } else {
                        done = true;
                    }
                } else {
                    done = true;
                }

                if done {
                    break;
                }
            }
        });

        Ok(info)
    }

    /// Stop a process by PID.
    pub async fn stop(&self, pid: u32) -> Result<bool, String> {
        let mut procs = self.processes.lock().await;
        let Some(proc) = procs.get_mut(&pid) else {
            return Ok(false);
        };

        if let Some(tree) = &proc.tree {
            tree.stop(std::time::Duration::from_millis(500))
                .await
                .map_err(|e| format!("Failed to stop process tree: {e}"))?;
        }
        if let Some(ref mut child) = proc.child {
            let status = match &proc.tree {
                Some(tree) => tree.wait(child).await,
                None => child.wait().await,
            }
            .map_err(|e| format!("Failed to reap process: {e}"))?;
            proc.info.running = false;
            proc.info.exit_code = status.code();
            proc.info.exited_at = Some(iso_timestamp());
        }

        Ok(true)
    }

    /// Get all tracked processes.
    pub async fn list_all(&self) -> Vec<ProcessInfo> {
        let procs = self.processes.lock().await;
        procs.values().map(|p| p.info.clone()).collect()
    }

    /// Get active (running) processes only.
    pub async fn list_active(&self) -> Vec<ProcessInfo> {
        let procs = self.processes.lock().await;
        procs
            .values()
            .filter(|p| p.info.running)
            .map(|p| p.info.clone())
            .collect()
    }

    /// Get logs for a process by PID.
    pub async fn get_logs_by_pid(
        &self,
        pid: u32,
        since: Option<i64>,
    ) -> Option<Vec<ProcessLogEntry>> {
        let procs = self.processes.lock().await;
        let proc = procs.get(&pid)?;
        let logs = if let Some(since) = since {
            proc.logs
                .iter()
                .filter(|l| l.timestamp > since)
                .cloned()
                .collect()
        } else {
            proc.logs.clone()
        };
        Some(logs)
    }

    /// Get logs for a process by port.
    pub async fn get_logs_by_port(
        &self,
        port: u16,
        since: Option<i64>,
    ) -> Option<Vec<ProcessLogEntry>> {
        let procs = self.processes.lock().await;
        let proc = process_for_port(&procs, port)?;
        let logs = if let Some(since) = since {
            proc.logs
                .iter()
                .filter(|l| l.timestamp > since)
                .cloned()
                .collect()
        } else {
            proc.logs.clone()
        };
        Some(logs)
    }

    pub async fn get_logs_by_port_after_cursor(
        &self,
        port: u16,
        cursor: LogCursor,
    ) -> Option<Vec<ProcessLogEntry>> {
        let procs = self.processes.lock().await;
        let proc = process_for_port(&procs, port)?;

        if cursor.timestamp <= 0 {
            return Some(proc.logs.clone());
        }

        let mut result = Vec::new();
        let mut matched_cursor = cursor.id.is_none();

        for entry in &proc.logs {
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
            return Some(
                proc.logs
                    .iter()
                    .filter(|entry| entry.timestamp >= cursor.timestamp)
                    .cloned()
                    .collect(),
            );
        }

        Some(result)
    }

    /// Get process info by port.
    pub async fn get_info_by_port(&self, port: u16) -> Option<ProcessInfo> {
        let procs = self.processes.lock().await;
        process_for_port(&procs, port).map(|p| p.info.clone())
    }

    /// Clear logs for a process.
    pub async fn clear_logs(&self, pid: u32) -> bool {
        let mut procs = self.processes.lock().await;
        if let Some(proc) = procs.get_mut(&pid) {
            proc.logs.clear();
            true
        } else {
            false
        }
    }
}

fn process_for_port(
    processes: &HashMap<u32, ManagedProcess>,
    port: u16,
) -> Option<&ManagedProcess> {
    processes
        .values()
        .filter(|process| process.info.port == Some(port))
        .max_by_key(|process| {
            (
                process.info.running,
                // UTC RFC3339 timestamps may omit the fractional seconds.
                process.info.started_at.trim_end_matches('Z'),
                process.info.pid,
            )
        })
}

/// Port detection patterns matching the Node implementation.
fn detect_port(text: &str) -> Option<u16> {
    let patterns = [
        r"localhost:(\d{1,5})",
        r"127\.0\.0\.1:(\d{1,5})",
        r"0\.0\.0\.0:(\d{1,5})",
        r"(?i)port\s*[=:]\s*(\d{1,5})",
        r"(?i)(?:listening|running|started|server|http).*?(?:on|at|port|:)\s*(\d{1,5})",
    ];

    for pattern in &patterns {
        if let Ok(re) = regex_lite::Regex::new(pattern) {
            if let Some(caps) = re.captures(text) {
                if let Some(m) = caps.get(1) {
                    if let Ok(port) = m.as_str().parse::<u16>() {
                        if (3000..=65535).contains(&port) {
                            return Some(port);
                        }
                    }
                }
            }
        }
    }
    None
}

async fn read_stream(
    processes: Arc<Mutex<HashMap<u32, ManagedProcess>>>,
    pid: u32,
    stream_name: &'static str,
    reader: impl tokio::io::AsyncRead + Unpin,
) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let truncated = if line.len() > MAX_LOG_ENTRY_BYTES {
            format!(
                "{}...(truncated)",
                &line[..line.floor_char_boundary(MAX_LOG_ENTRY_BYTES)]
            )
        } else {
            line.clone()
        };

        let entry = ProcessLogEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: now_millis(),
            stream: stream_name.to_string(),
            data: truncated,
        };

        let mut procs = processes.lock().await;
        if let Some(proc) = procs.get_mut(&pid) {
            // Detect port from output
            if proc.info.port.is_none() {
                if let Some(port) = detect_port(&line) {
                    proc.info.port = Some(port);
                }
            }

            proc.logs.push(entry);
            if proc.logs.len() > MAX_LOGS_PER_PROCESS {
                proc.logs.remove(0);
            }
        }
    }
}

fn iso_timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("rfc3339 formatting should succeed")
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

    #[tokio::test]
    async fn port_lookups_prefer_running_then_latest_start_with_stable_pid_ties() {
        const PORT: u16 = 5173;
        for records in [
            vec![
                (11, false, "2026-10-23T11:00:00Z"),
                (12, false, "2026-10-23T11:00:00.5Z"),
            ],
            vec![
                (11, false, "2026-10-23T12:00:00Z"),
                (12, true, "2026-10-23T11:00:00Z"),
            ],
            vec![
                (11, false, "2026-10-23T10:00:00Z"),
                (12, false, "2026-10-23T11:00:00Z"),
            ],
            vec![
                (11, true, "2026-10-23T11:00:00Z"),
                (12, true, "2026-10-23T11:00:00Z"),
            ],
            vec![
                (11, true, "2026-10-23T10:00:00Z"),
                (12, true, "2026-10-23T11:00:00Z"),
            ],
        ] {
            for _ in 0..32 {
                let manager = ProcessManager::new();
                for &(pid, running, started_at) in &records {
                    manager.processes.lock().await.insert(
                        pid,
                        ManagedProcess {
                            info: ProcessInfo {
                                pid,
                                command: "synthetic".into(),
                                cwd: String::new(),
                                port: Some(PORT),
                                started_at: started_at.into(),
                                exited_at: None,
                                exit_code: None,
                                running,
                            },
                            logs: vec![ProcessLogEntry {
                                id: pid.to_string(),
                                timestamp: 100,
                                stream: "stdout".into(),
                                data: format!("server {pid}"),
                            }],
                            child: None,
                            tree: None,
                        },
                    );
                }
                let pid = manager.get_info_by_port(PORT).await.unwrap().pid;
                let logs = manager.get_logs_by_port(PORT, Some(99)).await.unwrap();
                let cursor_logs = manager
                    .get_logs_by_port_after_cursor(
                        PORT,
                        LogCursor {
                            timestamp: 100,
                            id: Some("old-server-cursor".into()),
                        },
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    (
                        pid,
                        logs.iter().map(|log| log.data.as_str()).collect::<Vec<_>>(),
                        cursor_logs
                            .iter()
                            .map(|log| log.data.as_str())
                            .collect::<Vec<_>>()
                    ),
                    (12, vec!["server 12"], vec!["server 12"])
                );
                assert!(manager
                    .get_logs_by_port(PORT, Some(100))
                    .await
                    .unwrap()
                    .is_empty());
                assert!(manager.get_info_by_port(PORT + 1).await.is_none());
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_terminates_owned_descendants() {
        assert_stop_terminates_owned_descendants("wait").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_terminates_descendants_after_the_parent_has_been_reaped() {
        assert_stop_terminates_owned_descendants("exit 0").await;
    }

    #[cfg(unix)]
    async fn assert_stop_terminates_owned_descendants(parent_action: &str) {
        let manager = ProcessManager::new();
        let fixture = tempfile::tempdir().unwrap();
        let child_pid_file = fixture.path().join("child.pid");
        let command =
            format!("sleep 60 & child=$!; printf '%s' \"$child\" > \"$1\"; {parent_action}");
        let started = manager
            .start(
                fixture.path().to_str().unwrap(),
                "sh",
                &["-c", &command, "fixture", child_pid_file.to_str().unwrap()],
            )
            .await
            .unwrap();
        let child_pid: i32 = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(pid) = std::fs::read_to_string(&child_pid_file)
                    .ok()
                    .and_then(|s| s.parse().ok())
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        let stopped = manager.stop(started.pid).await;
        let exited = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = std::process::Command::new("ps")
                    .args(["-o", "stat=", "-p", &child_pid.to_string()])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&state.stdout);
                if state.trim().is_empty() || state.trim().starts_with('Z') {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe {
                libc::kill(child_pid, libc::SIGKILL);
            }
        }
        assert!(stopped.unwrap());
        assert!(exited.is_ok(), "Owned descendant survived Stop");
        assert!(manager.list_active().await.is_empty());
    }

    #[tokio::test]
    async fn unicode_log_truncation_keeps_subsequent_lines() {
        let processes = Arc::new(Mutex::new(HashMap::new()));
        let pid = 1;
        processes.lock().await.insert(
            pid,
            ManagedProcess {
                info: ProcessInfo {
                    pid,
                    command: "fixture".into(),
                    cwd: String::new(),
                    port: None,
                    started_at: iso_timestamp(),
                    exited_at: None,
                    exit_code: None,
                    running: false,
                },
                logs: Vec::new(),
                child: None,
                tree: None,
            },
        );
        let prefix = "a".repeat(MAX_LOG_ENTRY_BYTES - 1);
        let input = format!("{prefix}🙂\nListening on localhost:5173\n");
        read_stream(processes.clone(), pid, "stdout", input.as_bytes()).await;
        let procs = processes.lock().await;
        let proc = procs.get(&pid).unwrap();
        assert_eq!(
            (
                proc.logs
                    .iter()
                    .map(|entry| entry.data.as_str())
                    .collect::<Vec<_>>(),
                proc.info.port
            ),
            (
                vec![
                    format!("{prefix}...(truncated)").as_str(),
                    "Listening on localhost:5173"
                ],
                Some(5173)
            )
        );
    }

    #[test]
    fn detect_port_from_localhost() {
        assert_eq!(
            detect_port("Listening on http://localhost:3000"),
            Some(3000)
        );
    }

    #[test]
    fn detect_port_from_127() {
        assert_eq!(detect_port("Server at 127.0.0.1:8080"), Some(8080));
    }

    #[test]
    fn detect_port_from_port_equals() {
        assert_eq!(detect_port("PORT=5173"), Some(5173));
    }

    #[test]
    fn detect_port_rejects_low_ports() {
        assert_eq!(detect_port("localhost:80"), None);
    }

    #[test]
    fn detect_port_no_match() {
        assert_eq!(detect_port("no port here"), None);
    }

    #[tokio::test]
    async fn start_updates_process_state_after_late_exit() {
        let manager = ProcessManager::new();
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_string_lossy().to_string();

        let (command, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "ping 127.0.0.1 -n 4 > NUL"])
        } else {
            ("sh", vec!["-c", "sleep 3"])
        };

        let started = manager
            .start(&cwd, command, &args)
            .await
            .expect("process should start");

        tokio::time::sleep(Duration::from_secs(5)).await;

        let process = manager
            .list_all()
            .await
            .into_iter()
            .find(|proc| proc.pid == started.pid)
            .expect("started process should be tracked");

        assert!(!process.running);
        assert!(process.exited_at.is_some());
    }
}
