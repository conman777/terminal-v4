use std::env;
use std::ffi::OsString;
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent};

const DESKTOP_LOOPBACK_HOST: &str = "127.0.0.1";
const DESKTOP_LAN_HOST: &str = "0.0.0.0";
const DESKTOP_PORT: u16 = 3020;
const BACKEND_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const BACKEND_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct BackendProcess(Mutex<Option<Child>>);

fn io_error(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::Other, message.into())
}

fn parse_env_file(contents: &str) -> Vec<(String, String)> {
    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }

            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|trimmed| trimmed.strip_suffix('"'))
                .or_else(|| {
                    value
                        .strip_prefix('\'')
                        .and_then(|trimmed| trimmed.strip_suffix('\''))
                })
                .unwrap_or(value)
                .to_string();

            Some((key.to_string(), value))
        })
        .collect()
}

fn load_backend_env_file(repo_root: &Path) -> Result<Vec<(String, String)>> {
    let env_path = repo_root.join("backend").join(".env");
    match std::fs::read_to_string(&env_path) {
        Ok(contents) => Ok(parse_env_file(&contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(io_error(format!(
            "Failed to read backend env file at {}: {error}",
            env_path.display()
        ))),
    }
}

fn env_value_from_sources(key: &str, backend_env: &[(String, String)]) -> Option<String> {
    env::var(key).ok().or_else(|| {
        backend_env
            .iter()
            .find_map(|(env_key, env_value)| (env_key == key).then(|| env_value.clone()))
    })
}

fn resolve_repo_root() -> Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(|path| path.to_path_buf())
        .ok_or_else(|| io_error("Failed to resolve repository root from CARGO_MANIFEST_DIR"))
}

fn desktop_share_mode() -> String {
    env::var("TERMINAL_V4_SHARE_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "off".to_string())
}

fn desktop_backend_host(share_mode: &str) -> &'static str {
    if share_mode == "lan" {
        DESKTOP_LAN_HOST
    } else {
        DESKTOP_LOOPBACK_HOST
    }
}

fn desktop_health_host() -> &'static str {
    DESKTOP_LOOPBACK_HOST
}

fn desktop_jwt_secret(share_mode: &str, backend_env: &[(String, String)]) -> Option<String> {
    let configured = env_value_from_sources("JWT_SECRET", backend_env)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if configured.is_some() || share_mode != "lan" {
        return configured;
    }

    let seed = format!(
        "desktop-lan-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default()
    );
    Some(seed)
}

fn spawn_backend<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> Result<Child> {
    assert_backend_port_available()?;

    let repo_root = resolve_repo_root()?;
    let backend_env = load_backend_env_file(&repo_root)?;
    let rust_bin = find_rust_binary(app_handle, &repo_root).ok_or_else(|| {
    io_error(
      "Rust backend binary not found. Build it with `cargo build -p terminal-v4-api --manifest-path rust/Cargo.toml` before launching the desktop app.",
    )
  })?;
    let data_dir = resolve_data_dir(app_handle, &backend_env)?;
    let share_mode = desktop_share_mode();
    let backend_host = desktop_backend_host(&share_mode);
    let jwt_secret = desktop_jwt_secret(&share_mode, &backend_env);

    std::fs::create_dir_all(&data_dir)
        .map_err(|err| io_error(format!("Failed to create desktop data directory: {err}")))?;

    eprintln!("[tauri] Starting Rust backend: {}", rust_bin.display());
    let mut command = Command::new(&rust_bin);
    for (key, value) in &backend_env {
        if env::var_os(key).is_none() {
            command.env(key, value);
        }
    }
    command
        .env("HOST", backend_host)
        .env("PORT", DESKTOP_PORT.to_string())
        .env("TERMINAL_DATA_DIR", &data_dir)
        .env("TERMINAL_V4_DESKTOP", "true")
        .env("TERMINAL_V4_SHARE_MODE", &share_mode)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());

    if let Some(secret) = jwt_secret {
        command.env("JWT_SECRET", secret);
    }

    command
        .spawn()
        .map_err(|err| io_error(format!("Failed to launch Rust backend: {err}")))
}

fn resolve_data_dir<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    backend_env: &[(String, String)],
) -> Result<PathBuf> {
    if let Some(path) = resolve_data_dir_override(backend_env) {
        return Ok(PathBuf::from(path));
    }

    app_handle
        .path()
        .app_local_data_dir()
        .map_err(|_| io_error("Failed to resolve the desktop app data directory"))
}

fn resolve_data_dir_override(backend_env: &[(String, String)]) -> Option<OsString> {
    env::var_os("TERMINAL_DATA_DIR").or_else(|| {
        backend_env
            .iter()
            .find_map(|(key, value)| (key == "TERMINAL_DATA_DIR").then(|| OsString::from(value)))
    })
}

fn find_rust_binary<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    repo_root: &Path,
) -> Option<PathBuf> {
    let binary_name = if cfg!(windows) {
        "terminal-v4-api.exe"
    } else {
        "terminal-v4-api"
    };

    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("TERMINAL_V4_API_BINARY") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join(binary_name));
        candidates.push(resource_dir.join("bin").join(binary_name));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join(binary_name));
            candidates.push(exe_dir.join("bin").join(binary_name));
        }
    }

    candidates.push(
        repo_root
            .join("rust")
            .join("target")
            .join("release")
            .join(binary_name),
    );
    candidates.push(
        repo_root
            .join("rust")
            .join("target")
            .join("debug")
            .join(binary_name),
    );

    candidates.into_iter().find(|path| path.exists())
}

fn backend_is_healthy() -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DESKTOP_PORT);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    if stream
        .write_all(
            format!(
                "GET /api/health HTTP/1.1\r\nHost: {}:{DESKTOP_PORT}\r\nConnection: close\r\n\r\n",
                desktop_health_host()
            )
            .as_bytes(),
        )
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"")
}

fn assert_backend_port_available() -> Result<()> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DESKTOP_PORT);
    if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
        return Err(io_error(format!(
      "Desktop backend port {DESKTOP_PORT} is already in use on {}. Stop the existing service before launching the desktop app.",
      desktop_health_host()
    )));
    }

    Ok(())
}

fn wait_for_backend() -> Result<()> {
    let start = Instant::now();

    loop {
        if backend_is_healthy() {
            return Ok(());
        }

        if start.elapsed() >= BACKEND_WAIT_TIMEOUT {
            return Err(io_error(format!(
                "Backend did not become ready at http://{}:{DESKTOP_PORT} within {} seconds",
                desktop_health_host(),
                BACKEND_WAIT_TIMEOUT.as_secs()
            )));
        }

        std::thread::sleep(BACKEND_POLL_INTERVAL);
    }
}

fn stop_backend(state: &BackendProcess) {
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let mut child = spawn_backend(&app_handle)?;

            if let Err(err) = wait_for_backend() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err.into());
            }

            let state = app.state::<BackendProcess>();
            let mut guard = state
                .0
                .lock()
                .map_err(|_| io_error("Failed to lock backend process state"))?;
            *guard = Some(child);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                let state = app_handle.state::<BackendProcess>();
                stop_backend(&state);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{parse_env_file, resolve_data_dir_override};
    use std::ffi::OsString;

    #[test]
    fn parse_env_file_reads_plain_and_quoted_pairs() {
        let parsed = parse_env_file(
            r#"
            # comment
            STORAGE_DATABASE_URL=postgres://db.example/app
            TERMINAL_DATA_DIR="C:\Users\conor\AppData\Local\terminal-v4"
            EMPTY=
            "#,
        );

        assert_eq!(
            parsed,
            vec![
                (
                    "STORAGE_DATABASE_URL".to_string(),
                    "postgres://db.example/app".to_string()
                ),
                (
                    "TERMINAL_DATA_DIR".to_string(),
                    r"C:\Users\conor\AppData\Local\terminal-v4".to_string()
                ),
                ("EMPTY".to_string(), "".to_string()),
            ]
        );
    }

    #[test]
    fn resolve_data_dir_override_uses_backend_env_when_process_env_missing() {
        let backend_env = vec![(
            "TERMINAL_DATA_DIR".to_string(),
            r"C:\Users\conor\AppData\Local\terminal-v4".to_string(),
        )];

        let resolved = resolve_data_dir_override(&backend_env);

        assert_eq!(
            resolved,
            Some(OsString::from(r"C:\Users\conor\AppData\Local\terminal-v4"))
        );
    }
}
