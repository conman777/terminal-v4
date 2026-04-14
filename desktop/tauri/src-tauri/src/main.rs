use std::env;
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

fn desktop_jwt_secret(share_mode: &str) -> Option<String> {
    let configured = env::var("JWT_SECRET")
        .ok()
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
    let rust_bin = find_rust_binary(app_handle, &repo_root).ok_or_else(|| {
    io_error(
      "Rust backend binary not found. Build it with `cargo build -p terminal-v4-api --manifest-path rust/Cargo.toml` before launching the desktop app.",
    )
  })?;
    let data_dir = resolve_data_dir(app_handle)?;
    let share_mode = desktop_share_mode();
    let backend_host = desktop_backend_host(&share_mode);
    let jwt_secret = desktop_jwt_secret(&share_mode);

    std::fs::create_dir_all(&data_dir)
        .map_err(|err| io_error(format!("Failed to create desktop data directory: {err}")))?;

    eprintln!("[tauri] Starting Rust backend: {}", rust_bin.display());
    let mut command = Command::new(&rust_bin);
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

fn resolve_data_dir<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("TERMINAL_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }

    app_handle
        .path()
        .app_local_data_dir()
        .map_err(|_| io_error("Failed to resolve the desktop app data directory"))
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
