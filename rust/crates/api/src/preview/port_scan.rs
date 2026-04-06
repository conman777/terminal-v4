use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;

const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePort {
    pub port: u16,
    pub listening: bool,
    pub process: Option<String>,
    pub cwd: Option<String>,
    pub reachable: bool,
}

pub struct PortScanner {
    cache: Arc<Mutex<Option<(Vec<ActivePort>, Instant)>>>,
}

impl PortScanner {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Get active ports, using cache if fresh enough.
    pub async fn get_active_ports(&self) -> Vec<ActivePort> {
        let mut cache = self.cache.lock().await;
        if let Some((ref ports, ref ts)) = *cache {
            if ts.elapsed() < CACHE_TTL {
                return ports.clone();
            }
        }

        let ports = scan_ports().await;
        *cache = Some((ports.clone(), Instant::now()));
        ports
    }

    /// Force a rescan, bypassing cache.
    pub async fn force_scan(&self) -> Vec<ActivePort> {
        let ports = scan_ports().await;
        let mut cache = self.cache.lock().await;
        *cache = Some((ports.clone(), Instant::now()));
        ports
    }
}

async fn scan_ports() -> Vec<ActivePort> {
    let raw = if cfg!(windows) {
        scan_windows().await
    } else {
        scan_unix().await
    };

    let mut ports: Vec<ActivePort> = raw
        .into_iter()
        .filter(|p| p.port >= 3000)
        .collect();

    ports.sort_by_key(|p| p.port);
    ports.dedup_by_key(|p| p.port);
    ports
}

async fn scan_windows() -> Vec<ActivePort> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .await;

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let mut ports = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        if parts[3] != "LISTENING" {
            continue;
        }
        // Local address is like 0.0.0.0:port or [::]:port
        let addr = parts[1];
        if let Some(port_str) = addr.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                let pid = parts.get(4).and_then(|p| p.parse::<u32>().ok());
                ports.push(ActivePort {
                    port,
                    listening: true,
                    process: pid.map(|p| format!("PID:{p}")),
                    cwd: None,
                    reachable: true,
                });
            }
        }
    }
    ports
}

async fn scan_unix() -> Vec<ActivePort> {
    // Try `ss` first, fall back to `lsof`
    let output = Command::new("ss")
        .args(["-tlnp"])
        .output()
        .await;

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => {
            // Fallback to lsof
            return scan_lsof().await;
        }
    };

    let mut ports = Vec::new();
    for line in output.lines().skip(1) {
        // ss output: State Recv-Q Send-Q Local_Address:Port Peer_Address:Port Process
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let local = parts[3];
        if let Some(port_str) = local.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                let process = parts.get(5).map(|s| s.to_string());
                ports.push(ActivePort {
                    port,
                    listening: true,
                    process,
                    cwd: None,
                    reachable: true,
                });
            }
        }
    }
    ports
}

async fn scan_lsof() -> Vec<ActivePort> {
    let output = Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-nP"])
        .output()
        .await;

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let mut ports = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 {
            continue;
        }
        // Name column (index 8) contains host:port
        let name = parts[8];
        if let Some(port_str) = name.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                let process = Some(parts[0].to_string());
                ports.push(ActivePort {
                    port,
                    listening: true,
                    process,
                    cwd: None,
                    reachable: true,
                });
            }
        }
    }
    ports
}
