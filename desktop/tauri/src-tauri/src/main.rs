use std::env;
use std::ffi::OsString;
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

const DESKTOP_LOOPBACK_HOST: &str = "127.0.0.1";
const DESKTOP_LAN_HOST: &str = "0.0.0.0";
// The same port and data folder as the browser-hosted app, so both show the same threads.
const DESKTOP_PORT: u16 = 3030;
const SHARED_DATA_FOLDER: &str = "terminal-v4";
const GATEWAY_PORT: u16 = 3040;
const RESTART_DELAY_MAX: Duration = Duration::from_secs(30);
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
const BACKEND_WAIT_TIMEOUT: Duration = Duration::from_secs(20);
const BACKEND_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Processes the app owns, like T3 Code's desktop app: the API server and the Tailscale phone gateway.
struct BackendProcess {
    server: Mutex<Option<Child>>,
    gateway: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

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

fn desktop_backend_mode(value: Option<&str>) -> Result<bool> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("owned") => Ok(false),
        Some("attach") => Ok(true),
        Some(_) => Err(io_error("TERMINAL_V4_BACKEND_MODE must be owned or attach")),
    }
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

fn frontend_summary(dir: &Path) -> String {
    let index = dir.join("index.html");
    let built = std::fs::metadata(&index)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let main_script = std::fs::read_to_string(&index)
        .ok()
        .and_then(|html| {
            let start = html.find("assets/index-")?;
            let tail = &html[start..];
            Some(tail[..tail.find('"')?].to_string())
        })
        .unwrap_or_else(|| "none".to_string());
    format!(
        "{} (index.html modified unix={built}, main={main_script})",
        dir.display()
    )
}

fn select_frontend_dir(checkout: &Path, bundled: Option<&Path>) -> Option<PathBuf> {
    let checkout_ready = checkout.join("index.html").is_file();
    let bundled = bundled.filter(|dir| dir.join("index.html").is_file());
    if checkout_ready {
        if let Some(bundled) = bundled {
            let same = std::fs::read(checkout.join("index.html")).ok()
                == std::fs::read(bundled.join("index.html")).ok();
            if !same {
                eprintln!(
                    "[tauri] WARNING: checkout frontend differs from the bundled frontend; serving checkout. checkout={} bundled={}. Verify it matches the backend with scripts/verify-deployment.mjs.",
                    frontend_summary(checkout),
                    frontend_summary(bundled)
                );
            }
        }
        eprintln!("[tauri] Serving frontend: {}", frontend_summary(checkout));
        return Some(checkout.to_path_buf());
    }
    if let Some(bundled) = bundled {
        eprintln!(
            "[tauri] Serving bundled frontend: {}",
            frontend_summary(bundled)
        );
        return Some(bundled.to_path_buf());
    }
    eprintln!(
        "[tauri] WARNING: no frontend dist found at {} or in app resources",
        checkout.display()
    );
    None
}

fn spawn_backend<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> Result<Child> {
    assert_backend_port_available()?;

    let repo_root = resolve_repo_root()?;
    let backend_env = if cfg!(debug_assertions) {
        load_backend_env_file(&repo_root)?
    } else {
        Vec::new()
    };
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
        // Username sign-in (e.g. "conor") on this Mac and through the Tailscale gateway.
        .env(
            "TERMINAL_V4_LOCAL_TESTING",
            if share_mode == "lan" { "0" } else { "1" },
        )
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());

    if let Some(secret) = jwt_secret {
        command.env("JWT_SECRET", secret);
    }
    let bundled_frontend = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|resources| resources.join("frontend").join("dist"));
    if let Some(frontend) = select_frontend_dir(
        &repo_root.join("frontend").join("dist"),
        bundled_frontend.as_deref(),
    ) {
        command.env("TERMINAL_V4_FRONTEND_DIR", frontend);
    }
    if let Ok(resources) = app_handle.path().resource_dir() {
        if resources.join("scripts").is_dir() || resources.join("browser-runtime").is_dir() {
            command.env("TERMINAL_V4_RUNTIME_ROOT", &resources);
        }
    }
    let resources = app_handle.path().resource_dir().ok();
    let executable = env::current_exe().ok();
    let explicit_browser =
        env_value_from_sources("TERMINAL_V4_BROWSER_RUNTIME_DIR", &backend_env).map(PathBuf::from);
    let browser_root = select_browser_runtime(
        explicit_browser.as_deref(),
        resources.as_deref(),
        executable.as_deref().and_then(Path::parent),
        &repo_root,
    );
    configure_browser_runtime(
        &mut command,
        &browser_root?,
        Some(desktop_runtime_path(
            env::var_os("PATH"),
            env::var_os("HOME"),
        )?),
    )?;

    command
        .spawn()
        .map_err(|err| io_error(format!("Failed to launch Rust backend: {err}")))
}

fn browser_node(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    })
}

fn select_browser_runtime(
    explicit: Option<&Path>,
    resources: Option<&Path>,
    executable_dir: Option<&Path>,
    repo_root: &Path,
) -> Result<PathBuf> {
    let candidates: Vec<PathBuf> = if let Some(root) = explicit {
        if root.as_os_str().is_empty() {
            return Err(io_error("TERMINAL_V4_BROWSER_RUNTIME_DIR is empty"));
        }
        vec![root.to_path_buf()]
    } else {
        resources
            .map(|root| root.join("browser-runtime"))
            .into_iter()
            .chain(executable_dir.map(|root| root.join("browser-runtime")))
            .chain(std::iter::once(repo_root.join(".runtime/browser")))
            .collect()
    };
    for root in candidates {
        if explicit.is_some() || root.try_exists()? {
            if root.join("runtime.json").is_file() && browser_node(&root).is_file() {
                return Ok(root);
            }
            return Err(io_error(format!("Incomplete app-owned browser runtime at {}. Run `npm run browser:install` or reinstall the desktop app.", root.display())));
        }
    }
    Err(io_error("App-owned browser runtime missing. Run `npm run browser:install` or reinstall the desktop app."))
}

fn configure_browser_runtime(
    command: &mut Command,
    root: &Path,
    inherited_path: Option<OsString>,
) -> Result<()> {
    let node = browser_node(root);
    let mut paths = vec![node
        .parent()
        .ok_or_else(|| io_error("Invalid owned Node path"))?
        .to_path_buf()];
    paths.extend(
        inherited_path
            .as_deref()
            .map(env::split_paths)
            .into_iter()
            .flatten(),
    );
    command
        .env("TERMINAL_V4_BROWSER_RUNTIME_DIR", root)
        .env("PLAYWRIGHT_NODE_BIN", node)
        .env("PLAYWRIGHT_BROWSERS_PATH", root.join("browsers"))
        .env(
            "PATH",
            env::join_paths(paths).map_err(|error| io_error(error.to_string()))?,
        );
    Ok(())
}

fn desktop_runtime_path(inherited: Option<OsString>, home: Option<OsString>) -> Result<OsString> {
    let mut paths: Vec<PathBuf> = inherited
        .as_deref()
        .map(env::split_paths)
        .into_iter()
        .flatten()
        .filter(|path| path.is_absolute())
        .collect();
    #[cfg(unix)]
    {
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        if let Some(home) = home {
            candidates.insert(0, PathBuf::from(&home).join(".local/bin"));
            candidates.push(PathBuf::from(home).join(".cargo/bin"));
        }
        for path in candidates {
            if path.is_dir() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = home;
    env::join_paths(paths)
        .map_err(|error| io_error(format!("Invalid desktop runtime PATH: {error}")))
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
        .data_dir()
        .map(|base| shared_data_dir(&base))
        .map_err(|_| io_error("Failed to resolve the desktop app data directory"))
}

/// `~/Library/Application Support/terminal-v4` on macOS: the folder the server always uses.
fn shared_data_dir(base: &Path) -> PathBuf {
    base.join(SHARED_DATA_FOLDER)
}

fn resolve_data_dir_override(backend_env: &[(String, String)]) -> Option<OsString> {
    env::var_os("TERMINAL_DATA_DIR").or_else(|| {
        backend_env
            .iter()
            .find_map(|(key, value)| (key == "TERMINAL_DATA_DIR").then(|| OsString::from(value)))
    })
}

fn repository_binary_candidates(
    repo_root: &Path,
    binary_name: &str,
    development: bool,
) -> [PathBuf; 2] {
    let profiles = if development {
        ["debug", "release"]
    } else {
        ["release", "debug"]
    };
    profiles.map(|profile| {
        repo_root
            .join("rust")
            .join("target")
            .join(profile)
            .join(binary_name)
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

    // The checkout's release build comes first, so `cargo build --release` plus a server
    // restart (the app restarts it automatically) picks up backend changes during development.
    if !cfg!(debug_assertions) {
        candidates.push(
            repo_root
                .join("rust")
                .join("target")
                .join("release")
                .join(binary_name),
        );
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

    candidates.extend(repository_binary_candidates(
        repo_root,
        binary_name,
        cfg!(debug_assertions),
    ));

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
    state.stopping.store(true, Ordering::SeqCst);
    for slot in [&state.gateway, &state.server] {
        if let Some(mut child) = slot.lock().ok().and_then(|mut guard| guard.take()) {
            stop_backend_child(&mut child);
        }
    }
}

/// Waits 1, 2, 4… seconds (at most 30) between restarts after repeated failures.
fn restart_delay(failures: u32) -> Duration {
    Duration::from_secs(1u64 << failures.min(5)).min(RESTART_DELAY_MAX)
}

/// Restarts a process whenever it exits until the app quits, backing off while it keeps failing.
fn keep_running<R: tauri::Runtime>(
    app: AppHandle<R>,
    name: &'static str,
    slot: fn(&BackendProcess) -> &Mutex<Option<Child>>,
    start: fn(&AppHandle<R>) -> Result<Child>,
) {
    std::thread::spawn(move || {
        let mut failures = 0u32;
        loop {
            let state = app.state::<BackendProcess>();
            let watching_since = Instant::now();
            loop {
                if state.stopping.load(Ordering::SeqCst) {
                    return;
                }
                let exited = match slot(&state).lock() {
                    Ok(mut guard) => match guard.as_mut() {
                        Some(child) => !matches!(child.try_wait(), Ok(None)),
                        None => true,
                    },
                    Err(_) => return,
                };
                if exited {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if watching_since.elapsed() >= HEALTHY_UPTIME {
                failures = 0;
            }
            let delay = restart_delay(failures);
            failures = failures.saturating_add(1);
            eprintln!("[tauri] {name} stopped; restarting in {}s", delay.as_secs());
            std::thread::sleep(delay);
            if state.stopping.load(Ordering::SeqCst) {
                return;
            }
            match start(&app) {
                Ok(child) => {
                    if let Ok(mut guard) = slot(&state).lock() {
                        *guard = Some(child);
                    }
                }
                Err(error) => eprintln!("[tauri] {name} could not restart: {error}"),
            }
        }
    });
}

/// Where the phone reaches the app: Tailscale Serve forwards to the gateway, which checks the
/// Tailscale identity before passing requests to the server.
#[derive(Debug, PartialEq)]
struct GatewaySettings {
    allowed_login: String,
    external_host: String,
    origin: String,
}

fn gateway_settings(
    status: &serde_json::Value,
    serve: &serde_json::Value,
    gateway_port: u16,
) -> Option<GatewaySettings> {
    let own = &status["Self"];
    let host = own["DNSName"].as_str()?.trim_end_matches('.').to_string();
    let user_id = own["UserID"].as_u64()?.to_string();
    let allowed_login = status["User"][&user_id]["LoginName"].as_str()?.to_string();
    let target = format!("http://127.0.0.1:{gateway_port}");
    let served = serve["Web"].as_object()?.iter().find(|(_, web)| {
        web["Handlers"].as_object().is_some_and(|handlers| {
            handlers
                .values()
                .any(|handler| handler["Proxy"] == target.as_str())
        })
    })?;
    let (served_host, port) = served.0.rsplit_once(':')?;
    if served_host != host {
        return None;
    }
    let origin = match port {
        "443" => format!("https://{host}"),
        "8080" => format!("http://{host}:8080"),
        _ => return None,
    };
    Some(GatewaySettings {
        allowed_login,
        external_host: host,
        origin,
    })
}

fn tailscale_json(args: &[&str]) -> Option<serde_json::Value> {
    let cli = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "tailscale",
    ]
    .into_iter()
    .find(|candidate| !candidate.starts_with('/') || Path::new(candidate).is_file())?;
    let output = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())
        .flatten()
}

fn spawn_gateway<R: tauri::Runtime>(app_handle: &AppHandle<R>) -> Result<Child> {
    let settings = gateway_settings(
        &tailscale_json(&["status", "--json"])
            .ok_or_else(|| io_error("Tailscale is not running"))?,
        &tailscale_json(&["serve", "status", "--json"])
            .ok_or_else(|| io_error("Tailscale Serve status is unavailable"))?,
        GATEWAY_PORT,
    )
    .ok_or_else(|| io_error("Tailscale Serve does not forward to the app gateway"))?;
    let repo_root = resolve_repo_root()?;
    let script = repo_root.join("scripts").join("tailscale-local-proxy.mjs");
    let node = [
        Some(repo_root.join(".runtime").join("browser")),
        app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|resources| resources.join("browser-runtime")),
    ]
    .into_iter()
    .flatten()
    .map(|root| browser_node(&root))
    .find(|node| node.is_file())
    .ok_or_else(|| io_error("Bundled Node runtime not found for the Tailscale gateway"))?;
    if !script.is_file() {
        return Err(io_error("Tailscale gateway script not found"));
    }
    eprintln!("[tauri] Starting Tailscale gateway for {}", settings.origin);
    Command::new(node)
        .arg(script)
        .env("TAILSCALE_ALLOWED_LOGIN", settings.allowed_login)
        .env("TAILSCALE_EXTERNAL_HOST", settings.external_host)
        .env("TAILSCALE_APP_ORIGIN", settings.origin)
        .env("TAILSCALE_UPSTREAM_PORT", DESKTOP_PORT.to_string())
        .env("TAILSCALE_GATEWAY_PORT", GATEWAY_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| io_error(format!("Failed to start the Tailscale gateway: {err}")))
}

fn stop_backend_child(child: &mut Child) {
    stop_backend_child_with_grace(child, Duration::from_secs(15));
}

fn stop_backend_child_with_grace(child: &mut Child, grace: Duration) {
    #[cfg(not(unix))]
    let _ = grace;
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    tauri::Builder::default()
        .manage(BackendProcess {
            server: Mutex::new(None),
            gateway: Mutex::new(None),
            stopping: AtomicBool::new(false),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            if desktop_backend_mode(env::var("TERMINAL_V4_BACKEND_MODE").ok().as_deref())? {
                wait_for_backend()?;
                eprintln!("[tauri] Attached to existing backend; desktop exit leaves it running");
                return Ok(());
            }
            let mut child = spawn_backend(&app_handle)?;

            if let Err(err) = wait_for_backend() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err.into());
            }

            let state = app.state::<BackendProcess>();
            *state
                .server
                .lock()
                .map_err(|_| io_error("Failed to lock backend process state"))? = Some(child);
            keep_running(
                app_handle.clone(),
                "server",
                |state| &state.server,
                spawn_backend,
            );

            match spawn_gateway(&app_handle) {
                Ok(gateway) => {
                    if let Ok(mut guard) = state.gateway.lock() {
                        *guard = Some(gateway);
                    }
                    keep_running(
                        app_handle,
                        "Tailscale gateway",
                        |state| &state.gateway,
                        spawn_gateway,
                    );
                }
                Err(error) => eprintln!("[tauri] Phone access via Tailscale is off: {error}"),
            }

            Ok(())
        })
        // Like T3 Code: closing the window keeps the app (and its server) running until you quit.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                let state = app_handle.state::<BackendProcess>();
                stop_backend(&state);
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_backend_mode, desktop_runtime_path, parse_env_file, resolve_data_dir_override,
    };
    use super::{gateway_settings, restart_delay, shared_data_dir, GatewaySettings};
    use std::path::{Path, PathBuf};

    #[test]
    fn frontend_selection_prefers_checkout_then_bundled_then_none() {
        let root = std::env::temp_dir().join(format!("tauri-frontend-{}", std::process::id()));
        let (checkout, bundled) = (root.join("checkout"), root.join("bundled"));
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::create_dir_all(&bundled).unwrap();
        assert_eq!(super::select_frontend_dir(&checkout, Some(&bundled)), None);
        std::fs::write(bundled.join("index.html"), "b").unwrap();
        assert_eq!(
            super::select_frontend_dir(&checkout, Some(&bundled)),
            Some(bundled.clone())
        );
        std::fs::write(
            checkout.join("index.html"),
            "<script src=\"/assets/index-X.js\">",
        )
        .unwrap();
        assert_eq!(
            super::select_frontend_dir(&checkout, Some(&bundled)),
            Some(checkout.clone())
        );
        assert!(super::frontend_summary(&checkout).contains("main=assets/index-X.js"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restarts_back_off_up_to_thirty_seconds() {
        assert_eq!(
            [0, 1, 2, 4, 5, 9].map(|failures| restart_delay(failures).as_secs()),
            [1, 2, 4, 16, 30, 30]
        );
    }

    #[test]
    fn uses_the_same_data_folder_as_the_server() {
        assert_eq!(
            shared_data_dir(Path::new("/Users/me/Library/Application Support")),
            PathBuf::from("/Users/me/Library/Application Support/terminal-v4")
        );
    }

    #[test]
    fn finds_the_phone_gateway_from_tailscale_serve() {
        let status = serde_json::json!({
            "Self": {"DNSName": "mac.tail1.ts.net.", "UserID": 42},
            "User": {"42": {"LoginName": "me@example.com"}}
        });
        let serve = serde_json::json!({"Web": {
            "mac.tail1.ts.net:3000": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}},
            "mac.tail1.ts.net:8080": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3040"}}}
        }});
        let unserved = serde_json::json!({"Web": {}});
        assert_eq!(
            (
                gateway_settings(&status, &serve, 3040),
                gateway_settings(&status, &unserved, 3040)
            ),
            (
                Some(GatewaySettings {
                    allowed_login: "me@example.com".into(),
                    external_host: "mac.tail1.ts.net".into(),
                    origin: "http://mac.tail1.ts.net:8080".into(),
                }),
                None
            )
        );
    }

    #[test]
    fn desktop_browser_runtime_prefers_explicit_then_bundle_then_sibling_then_checkout() {
        let root = std::env::temp_dir().join(format!("v4-desktop-browser-{}", std::process::id()));
        let resources = root.join("Resources");
        let executable_dir = root.join("bin");
        let checkout = root.join("checkout");
        let dev = checkout.join(".runtime/browser");
        let sibling = executable_dir.join("browser-runtime");
        let bundled = resources.join("browser-runtime");
        let custom = root.join("custom browser");
        for candidate in [&dev, &sibling, &bundled, &custom] {
            let node = super::browser_node(candidate);
            std::fs::create_dir_all(node.parent().unwrap()).unwrap();
            std::fs::write(node, "fixture").unwrap();
            std::fs::write(candidate.join("runtime.json"), "{}").unwrap();
        }
        assert_eq!(
            super::select_browser_runtime(None, None, None, &checkout).unwrap(),
            dev
        );
        assert_eq!(
            super::select_browser_runtime(None, None, Some(&executable_dir), &checkout).unwrap(),
            sibling
        );
        assert_eq!(
            super::select_browser_runtime(None, Some(&resources), Some(&executable_dir), &checkout)
                .unwrap(),
            bundled
        );
        assert_eq!(
            super::select_browser_runtime(
                Some(&custom),
                Some(&resources),
                Some(&executable_dir),
                &checkout
            )
            .unwrap(),
            custom
        );
        assert!(super::select_browser_runtime(
            Some(&root.join("missing")),
            Some(&resources),
            None,
            &checkout
        )
        .is_err());
        std::fs::remove_file(bundled.join("runtime.json")).unwrap();
        assert!(super::select_browser_runtime(None, Some(&resources), None, &checkout).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_child_uses_owned_node_and_browser_root_without_host_node() {
        let root = std::path::Path::new("runtime");
        let mut command = std::process::Command::new("api");
        super::configure_browser_runtime(&mut command, root, Some(OsString::from("/host/bin")))
            .unwrap();
        let values: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.unwrap().to_os_string(),
                )
            })
            .collect();
        assert_eq!(values["TERMINAL_V4_BROWSER_RUNTIME_DIR"], root.as_os_str());
        assert_eq!(
            values["PLAYWRIGHT_NODE_BIN"],
            super::browser_node(root).as_os_str()
        );
        assert_eq!(
            values["PLAYWRIGHT_BROWSERS_PATH"],
            root.join("browsers").as_os_str()
        );
        assert_eq!(
            std::env::split_paths(&values["PATH"]).next().unwrap(),
            super::browser_node(root).parent().unwrap()
        );
    }

    #[test]
    fn development_prefers_debug_backend_and_packaged_build_prefers_release() {
        let root = std::path::Path::new("repo");
        let binary = "terminal-v4-api";
        let debug = root.join("rust/target/debug").join(binary);
        let release = root.join("rust/target/release").join(binary);
        assert_eq!(
            super::repository_binary_candidates(root, binary, true),
            [debug.clone(), release.clone()]
        );
        assert_eq!(
            super::repository_binary_candidates(root, binary, false),
            [release, debug]
        );
    }

    #[cfg(unix)]
    #[test]
    fn desktop_path_keeps_system_tools_and_discovers_user_cli_directory() {
        let root = std::env::temp_dir().join(format!("v4-path-{}", std::process::id()));
        let bin = root.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let resolved = desktop_runtime_path(
            Some("/usr/bin:/bin".into()),
            Some(root.clone().into_os_string()),
        )
        .unwrap();
        let paths: Vec<_> = std::env::split_paths(&resolved).collect();
        assert_eq!(
            &paths[..2],
            &[
                std::path::PathBuf::from("/usr/bin"),
                std::path::PathBuf::from("/bin")
            ]
        );
        assert!(paths.contains(&bin));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn backend_shutdown_allows_cleanup_before_forced_termination() {
        use std::io::Read;
        let mut child = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'exit 23' TERM; printf ready; while :; do sleep 0.1; done",
            ])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = [0; 5];
        child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        super::stop_backend_child(&mut child);
        assert_eq!(child.wait().unwrap().code(), Some(23));
    }
    #[cfg(unix)]
    #[test]
    fn backend_shutdown_allows_worker_cleanup_longer_than_five_seconds() {
        use std::io::Read;
        let mut child = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'sleep 6; exit 23' TERM; printf ready; while :; do sleep 0.1; done",
            ])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = [0; 5];
        child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        super::stop_backend_child(&mut child);
        assert_eq!(
            child.wait().unwrap().code(),
            Some(23),
            "Desktop forced termination before worker cleanup could finish"
        );
    }
    #[cfg(unix)]
    #[test]
    fn backend_shutdown_forces_a_noncooperating_child_after_its_deadline() {
        use std::{io::Read, os::unix::process::ExitStatusExt};
        let mut child = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "trap '' TERM; printf ready; while :; do sleep 0.1; done",
            ])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = [0; 5];
        child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        let started = std::time::Instant::now();
        super::stop_backend_child_with_grace(&mut child, std::time::Duration::from_millis(150));
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
    use std::ffi::OsString;

    #[test]
    fn attach_mode_is_explicit_and_unknown_modes_fail() {
        assert!(!desktop_backend_mode(None).unwrap());
        assert!(!desktop_backend_mode(Some("owned")).unwrap());
        assert!(desktop_backend_mode(Some("attach")).unwrap());
        assert!(desktop_backend_mode(Some("typo")).is_err());
    }

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
