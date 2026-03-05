use std::io::{Error, ErrorKind, Result};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

const DESKTOP_HOST: &str = "127.0.0.1";
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

fn build_desktop_backend_path() -> Option<String> {
  let current_path = std::env::var("PATH").ok()?;
  let app_data = std::env::var("APPDATA").ok()?;
  let npm_bin = PathBuf::from(app_data).join("npm");
  let npm_bin_str = npm_bin.to_string_lossy().to_string();
  if npm_bin_str.is_empty() {
    return Some(current_path);
  }

  let separator = if cfg!(windows) { ';' } else { ':' };
  let mut parts: Vec<String> = current_path
    .split(separator)
    .filter(|part| !part.trim().is_empty())
    .map(|part| part.to_string())
    .collect();

  let is_match = |candidate: &str| -> bool {
    if cfg!(windows) {
      candidate.eq_ignore_ascii_case(&npm_bin_str)
    } else {
      candidate == npm_bin_str
    }
  };

  parts.retain(|part| !is_match(part));
  parts.insert(0, npm_bin_str);
  Some(parts.join(&separator.to_string()))
}

fn spawn_backend() -> Result<Child> {
  let repo_root = resolve_repo_root()?;
  let backend_dir = repo_root.join("backend");
  let backend_entry = backend_dir.join("dist").join("index.js");

  if !backend_entry.exists() {
    return Err(io_error("backend/dist/index.js is missing. Run npm run desktop:predev first."));
  }

  let mut command = Command::new("node");
  command
    .arg("--enable-source-maps")
    .arg(&backend_entry)
    .current_dir(backend_dir)
    .env("HOST", DESKTOP_HOST)
    .env("PORT", DESKTOP_PORT.to_string())
    .env("TERMINAL_V4_DESKTOP", "true")
    .env("TERMINAL_V4_SHARE_MODE", "off")
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .stdin(Stdio::null());

  if let Some(path_override) = build_desktop_backend_path() {
    command.env("PATH", path_override);
  }

  command
    .spawn()
    .map_err(|err| io_error(format!("Failed to launch backend process: {err}")))
}

fn wait_for_backend() -> Result<()> {
  let start = Instant::now();
  let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DESKTOP_PORT);

  loop {
    if TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok() {
      return Ok(());
    }

    if start.elapsed() >= BACKEND_WAIT_TIMEOUT {
      return Err(io_error(format!(
        "Backend did not become ready at http://{DESKTOP_HOST}:{DESKTOP_PORT} within {} seconds",
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
      let mut child = spawn_backend()?;

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
