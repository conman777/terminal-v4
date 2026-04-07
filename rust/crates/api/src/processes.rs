use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_LOGS_PER_PROCESS: usize = 1000;
const MAX_LOG_ENTRY_BYTES: usize = 50 * 1024;

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
        let mut child = Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start process: {e}"))?;

        let pid = child.id().ok_or("Process has no PID")?;
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
        };

        {
            let mut procs = self.processes.lock().await;
            procs.insert(pid, managed);
        }

        tokio::spawn(async move {
            // Wait a bit then check for early exit
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let mut procs = processes_exit.lock().await;
            if let Some(proc) = procs.get_mut(&pid) {
                if let Some(ref mut child) = proc.child {
                    if let Ok(Some(status)) = child.try_wait() {
                        proc.info.running = false;
                        proc.info.exit_code = status.code();
                        proc.info.exited_at = Some(iso_timestamp());
                    }
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

        if let Some(ref mut child) = proc.child {
            let _ = child.kill().await;
            proc.info.running = false;
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
        let proc = procs.values().find(|p| p.info.port == Some(port))?;
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
        let proc = procs.values().find(|p| p.info.port == Some(port))?;

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
        procs
            .values()
            .find(|p| p.info.port == Some(port))
            .map(|p| p.info.clone())
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
            format!("{}...(truncated)", &line[..MAX_LOG_ENTRY_BYTES])
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
}
