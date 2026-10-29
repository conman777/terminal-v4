use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

pub(super) fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(probe)
}

fn probe() -> bool {
    cfg!(target_os = "macos")
        && Path::new(SANDBOX_EXEC).exists()
        && std::process::Command::new(SANDBOX_EXEC)
            .args([
                "-p",
                "(version 1)(allow default)(deny network*)",
                "/usr/bin/true",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

fn quoted(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("Cannot sandbox a non-UTF-8 path")?;
    if text.chars().any(char::is_control) {
        return Err("Cannot sandbox a path with control characters".into());
    }
    Ok(format!(
        "\"{}\"",
        text.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

pub(super) fn profile(
    workspace: &Path,
    directory: &Path,
    socket: &Path,
    temporary: &[PathBuf],
) -> Result<String, String> {
    let mut writable = vec![quoted(workspace)?, quoted(directory)?];
    for path in temporary {
        writable.push(quoted(path)?);
    }
    let writable = writable
        .iter()
        .map(|path| format!("(subpath {path})"))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote unix-socket (path-literal {})))\n(deny file-write*)\n(allow file-write* {writable} (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n",
        quoted(socket)?
    ))
}

pub(super) fn temporary_directories() -> Vec<PathBuf> {
    ["/tmp".into(), std::env::temp_dir()]
        .into_iter()
        .filter_map(|path: PathBuf| path.canonicalize().ok())
        .collect()
}

pub(super) fn command(profile: &str, script: &Path) -> tokio::process::Command {
    let mut process = tokio::process::Command::new(SANDBOX_EXEC);
    process.args(["-p", profile, "python3", "-u"]).arg(script);
    process
}

pub(super) fn describe() -> &'static str {
    if available() {
        "macOS sandbox: network access denied by the OS (only the tool channel is reachable); file writes limited to the workspace and temporary directories; file reads are NOT restricted"
    } else {
        "no OS sandbox is available on this host: the network guard inside Python is best effort and the script has the same host file access as run_command"
    }
}
