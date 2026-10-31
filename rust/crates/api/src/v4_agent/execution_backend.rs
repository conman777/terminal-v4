use std::{
    path::Path,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::process::Command;

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const APP_LABEL: &str = "terminal-v4.app=run-command";
const PID_LABEL: &str = "terminal-v4.pid";
const RUN_LABEL: &str = "terminal-v4.run";
const SSH_HOST_VARIABLE: &str = "V4_RUN_COMMAND_SSH_HOST";
const SSH_USER_VARIABLE: &str = "V4_RUN_COMMAND_SSH_USER";
const SSH_PORT_VARIABLE: &str = "V4_RUN_COMMAND_SSH_PORT";
const SSH_IDENTITY_VARIABLE: &str = "V4_RUN_COMMAND_SSH_IDENTITY";
const SSH_KNOWN_HOSTS_VARIABLE: &str = "V4_RUN_COMMAND_SSH_KNOWN_HOSTS";
const SSH_WORKDIR_VARIABLE: &str = "V4_RUN_COMMAND_SSH_WORKDIR";

pub(super) const BACKEND_VARIABLE: &str = "V4_RUN_COMMAND_BACKEND";
pub(super) const DOCKER_IMAGE_VARIABLE: &str = "V4_RUN_COMMAND_DOCKER_IMAGE";
const DOCKER_MEMORY_VARIABLE: &str = "V4_RUN_COMMAND_DOCKER_MEMORY";
const DOCKER_CPUS_VARIABLE: &str = "V4_RUN_COMMAND_DOCKER_CPUS";
const DOCKER_NETWORK_VARIABLE: &str = "V4_RUN_COMMAND_DOCKER_NETWORK";
const INHERITED_ENVIRONMENT: [&str; 8] = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "TERM",
];

pub(super) trait ExecutionBackend: Send + Sync {
    #[cfg_attr(not(test), allow(dead_code))]
    fn name(&self) -> &'static str;
    fn host_description(&self) -> String;
    fn command(&self, root: &Path, command: &str) -> Result<Command, String>;
    fn prepare(&self, root: &Path, command: &str) -> Result<PreparedCommand, String> {
        self.command(root, command).map(|command| PreparedCommand {
            command,
            cleanup: None,
        })
    }
}

pub(super) struct PreparedCommand {
    pub(super) command: Command,
    pub(super) cleanup: Option<ContainerCleanup>,
}

fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

fn scrubbed_std_command(program: &str) -> std::process::Command {
    let mut process = std::process::Command::new(program);
    process.env_clear();
    for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
        process.env(name, value);
    }
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    process
}

#[cfg(unix)]
fn bounded_output(mut process: std::process::Command, timeout: Duration) -> Option<String> {
    use std::{io::Read, os::fd::AsRawFd};

    const OUTPUT_LIMIT: usize = 1024 * 1024;
    let mut child = process.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }

    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut status = None;
    let mut eof = false;
    loop {
        let mut read_progress = false;
        if !eof {
            let mut buffer = [0u8; 8192];
            match stdout.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(count) if output.len() + count <= OUTPUT_LIMIT => {
                    output.extend_from_slice(&buffer[..count]);
                    read_progress = true;
                }
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => break,
            }
        }
        if let (Some(exit), true) = (status, eof) {
            return exit
                .success()
                .then(|| String::from_utf8(output).ok())
                .flatten();
        }
        if Instant::now() >= deadline {
            break;
        }
        if !read_progress {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    None
}

#[cfg(not(unix))]
fn bounded_output(mut process: std::process::Command, timeout: Duration) -> Option<String> {
    let mut child = process.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let text = reader.join().ok()?;
    finished.then_some(text)
}

pub(super) struct ContainerCleanup {
    program: String,
    name: String,
    directory: tempfile::TempDir,
    armed: bool,
}
impl ContainerCleanup {
    fn cidfile(&self) -> std::path::PathBuf {
        self.directory.path().join("container.id")
    }

    pub(super) fn force_remove(&mut self) -> Result<(), String> {
        let mut targets = vec![self.name.clone()];
        if let Ok(id) = std::fs::read_to_string(self.cidfile()) {
            let id = id.trim();
            if is_container_id(id) {
                targets.push(id.to_owned());
            }
        }
        for (index, target) in targets.iter().enumerate() {
            if index == 0 {
                let mut kill = scrubbed_std_command(&self.program);
                kill.args(["kill", target]);
                let _ = bounded_output(kill, CLEANUP_TIMEOUT);
            }
            let mut remove = scrubbed_std_command(&self.program);
            remove.args(["rm", "-f", target]);
            let _ = bounded_output(remove, CLEANUP_TIMEOUT);
        }
        let mut list = scrubbed_std_command(&self.program);
        list.args([
            "ps",
            "-a",
            "--filter",
            &format!("name=^/{}$", self.name),
            "--format",
            "{{.Names}}",
        ]);
        let listing = bounded_output(list, CLEANUP_TIMEOUT)
            .ok_or("Docker container cleanup is unconfirmed")?;
        if listing.lines().any(|name| !name.trim().is_empty()) {
            return Err("Docker container cleanup is unconfirmed".into());
        }
        self.armed = false;
        Ok(())
    }
}
impl Drop for ContainerCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.force_remove();
        }
    }
}

fn is_container_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 0
            && (unsafe { libc::kill(pid as i32, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

pub(super) fn dead_run_container_ids(
    listing: &str,
    current_run: &str,
    alive: &dyn Fn(u32) -> bool,
) -> Vec<String> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let (id, pid, run) = (fields.next()?, fields.next()?, fields.next()?);
            let pid: u32 = pid.trim().parse().ok()?;
            (is_container_id(id.trim())
                && !run.trim().is_empty()
                && run.trim() != current_run
                && !alive(pid))
            .then(|| id.trim().to_owned())
        })
        .collect()
}

pub(super) fn reap_leftover_containers(program: &str) -> usize {
    reap_with(program, run_id(), &process_is_alive)
}

fn reap_with(program: &str, current_run: &str, alive: &dyn Fn(u32) -> bool) -> usize {
    let mut list = scrubbed_std_command(program);
    list.args([
        "ps",
        "-a",
        "--filter",
        &format!("label={APP_LABEL}"),
        "--format",
        &format!("{{{{.ID}}}}\t{{{{.Label \"{PID_LABEL}\"}}}}\t{{{{.Label \"{RUN_LABEL}\"}}}}"),
    ]);
    let Some(listing) = bounded_output(list, CLEANUP_TIMEOUT) else {
        return 0;
    };
    let mut removed = 0;
    for id in dead_run_container_ids(&listing, current_run, alive) {
        let mut remove = scrubbed_std_command(program);
        remove.args(["rm", "-f", &id]);
        if bounded_output(remove, CLEANUP_TIMEOUT).is_some() {
            removed += 1;
        }
    }
    removed
}

pub(super) fn reap_from_environment() -> usize {
    match select(&|name| std::env::var(name).ok()) {
        Ok(backend) if backend.name() == "docker" => reap_leftover_containers("docker"),
        _ => 0,
    }
}

pub(super) fn scrubbed_host_environment(
    lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, std::ffi::OsString)> {
    INHERITED_ENVIRONMENT
        .iter()
        .filter_map(|name| lookup(name).map(|value| (*name, value)))
        .collect()
}

pub(super) struct LocalBackend;
impl ExecutionBackend for LocalBackend {
    fn name(&self) -> &'static str {
        "local"
    }
    fn host_description(&self) -> String {
        "runs on this host".into()
    }
    fn command(&self, root: &Path, command: &str) -> Result<Command, String> {
        let mut process = if cfg!(windows) {
            let mut p = Command::new("cmd.exe");
            p.args(["/d", "/s", "/c", command]);
            p
        } else {
            let mut p = Command::new("/bin/sh");
            p.args(["-c", command]);
            p
        };
        process.current_dir(root).env_clear();
        for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
            process.env(name, value);
        }
        Ok(process)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct DockerBackend {
    pub(super) program: String,
    pub(super) image: String,
    pub(super) memory: String,
    pub(super) cpus: String,
    pub(super) pids_limit: u32,
    pub(super) network: bool,
}
impl DockerBackend {
    pub(super) fn arguments(
        &self,
        root: &Path,
        command: &str,
        name: &str,
        cidfile: &Path,
    ) -> Vec<String> {
        let mut arguments: Vec<String> = ["run", "--rm", "--init"]
            .iter()
            .map(|value| value.to_string())
            .collect();
        arguments.extend([
            format!("--name={name}"),
            format!("--cidfile={}", cidfile.display()),
            format!("--label={APP_LABEL}"),
            format!("--label={PID_LABEL}={}", std::process::id()),
            format!("--label={RUN_LABEL}={}", run_id()),
        ]);
        arguments.push(format!(
            "--network={}",
            if self.network { "bridge" } else { "none" }
        ));
        arguments.push(format!("--memory={}", self.memory));
        arguments.push(format!("--cpus={}", self.cpus));
        arguments.push(format!("--pids-limit={}", self.pids_limit));
        arguments.extend([
            "--cap-drop=ALL".into(),
            "--security-opt=no-new-privileges".into(),
        ]);
        arguments.extend([
            "--pull=never".into(),
            "-v".into(),
            format!("{}:/workspace", root.display()),
            "-w".into(),
            "/workspace".into(),
            self.image.clone(),
            "/bin/sh".into(),
            "-c".into(),
            command.into(),
        ]);
        arguments
    }
}
impl ExecutionBackend for DockerBackend {
    fn name(&self) -> &'static str {
        "docker"
    }
    fn host_description(&self) -> String {
        format!(
            "runs in a Docker container from image {} with the workspace mounted read-write at /workspace, network {}",
            self.image,
            if self.network { "enabled" } else { "disabled" }
        )
    }
    fn command(&self, root: &Path, command: &str) -> Result<Command, String> {
        self.prepare(root, command).map(|prepared| prepared.command)
    }
    fn prepare(&self, root: &Path, command: &str) -> Result<PreparedCommand, String> {
        if self.image.is_empty()
            || self.image.starts_with('-')
            || self.image.contains(char::is_whitespace)
        {
            return Err("Docker execution backend image is invalid".into());
        }
        let root = root
            .canonicalize()
            .map_err(|_| "Workspace is unavailable")?;
        let root_text = root.to_string_lossy();
        if root_text.contains(':') || root_text.contains(',') {
            return Err("Workspace path cannot be mounted into Docker".into());
        }
        let directory = tempfile::Builder::new()
            .prefix("v4-container-")
            .tempdir()
            .map_err(|_| "Cannot prepare container tracking")?;
        let cleanup = ContainerCleanup {
            program: self.program.clone(),
            name: format!("v4-run-{}", uuid::Uuid::new_v4().simple()),
            directory,
            armed: true,
        };
        let mut process = Command::new(&self.program);
        process
            .args(self.arguments(&root, command, &cleanup.name, &cleanup.cidfile()))
            .env_clear();
        for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
            process.env(name, value);
        }
        Ok(PreparedCommand {
            command: process,
            cleanup: Some(cleanup),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SshBackend {
    pub(super) program: String,
    pub(super) host: String,
    pub(super) user: Option<String>,
    pub(super) port: Option<u16>,
    pub(super) identity: Option<String>,
    pub(super) known_hosts: Option<String>,
    pub(super) workdir: String,
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn is_ssh_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_plain_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 4096
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn is_remote_directory(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 4096 && !value.chars().any(char::is_control)
}

impl SshBackend {
    pub(super) fn arguments(&self, command: &str) -> Vec<String> {
        let mut arguments: Vec<String> = [
            "-n",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        if let Some(identity) = &self.identity {
            arguments.extend([
                "-o".into(),
                "IdentitiesOnly=yes".into(),
                "-i".into(),
                identity.clone(),
            ]);
        }
        if let Some(known_hosts) = &self.known_hosts {
            arguments.extend(["-o".into(), format!("UserKnownHostsFile={known_hosts}")]);
        }
        if let Some(port) = self.port {
            arguments.extend(["-p".into(), port.to_string()]);
        }
        if let Some(user) = &self.user {
            arguments.extend(["-l".into(), user.clone()]);
        }
        arguments.extend([
            "--".into(),
            self.host.clone(),
            format!(
                "cd -- {} && exec /bin/sh -c {}",
                shell_quote(&self.workdir),
                shell_quote(command)
            ),
        ]);
        arguments
    }
}
impl ExecutionBackend for SshBackend {
    fn name(&self) -> &'static str {
        "ssh"
    }
    fn host_description(&self) -> String {
        format!(
            "runs on the remote host {} over SSH in {} (not this machine; the workspace is not synchronised; remote commands may continue after cancellation or disconnection; the remote login shell must be POSIX)",
            self.host, self.workdir
        )
    }
    fn command(&self, _root: &Path, command: &str) -> Result<Command, String> {
        if !is_ssh_name(&self.host)
            || self.user.as_deref().is_some_and(|user| !is_ssh_name(user))
            || self
                .identity
                .as_deref()
                .into_iter()
                .chain(self.known_hosts.as_deref())
                .any(|path| !is_plain_absolute_path(path))
            || !is_remote_directory(&self.workdir)
        {
            return Err("SSH execution backend settings are invalid".into());
        }
        let mut process = Command::new(&self.program);
        process.args(self.arguments(command)).env_clear();
        for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
            process.env(name, value);
        }
        Ok(process)
    }
}

fn ssh_from_settings(lookup: &dyn Fn(&str) -> Option<String>) -> Result<SshBackend, String> {
    let setting = |name: &str| {
        lookup(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let host = setting(SSH_HOST_VARIABLE).ok_or("SSH execution backend requires a host setting")?;
    let workdir = setting(SSH_WORKDIR_VARIABLE)
        .ok_or("SSH execution backend requires a remote directory setting")?;
    let port = setting(SSH_PORT_VARIABLE)
        .map(|value| value.parse::<u16>().ok().filter(|port| *port > 0))
        .map(|port| port.ok_or("SSH execution backend port is invalid"))
        .transpose()?;
    let backend = SshBackend {
        program: "ssh".into(),
        host,
        user: setting(SSH_USER_VARIABLE),
        port,
        identity: setting(SSH_IDENTITY_VARIABLE),
        known_hosts: setting(SSH_KNOWN_HOSTS_VARIABLE),
        workdir,
    };
    backend.command(Path::new("/"), "true").map(|_| backend)
}

pub(super) fn select(
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Box<dyn ExecutionBackend>, String> {
    match lookup(BACKEND_VARIABLE).as_deref().map(str::trim) {
        None | Some("") | Some("local") => Ok(Box::new(LocalBackend)),
        Some("docker") => {
            let image = lookup(DOCKER_IMAGE_VARIABLE)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .ok_or("Docker execution backend requires an image setting")?;
            Ok(Box::new(DockerBackend {
                program: "docker".into(),
                image,
                memory: lookup(DOCKER_MEMORY_VARIABLE).unwrap_or_else(|| "512m".into()),
                cpus: lookup(DOCKER_CPUS_VARIABLE).unwrap_or_else(|| "1".into()),
                pids_limit: 256,
                network: matches!(lookup(DOCKER_NETWORK_VARIABLE).as_deref(), Some("enabled")),
            }))
        }
        Some("ssh") => {
            let _ = ssh_from_settings(lookup)?;
            Err(
                "SSH execution is disabled because remote command cleanup cannot be confirmed"
                    .into(),
            )
        }
        Some(_) => Err("Unknown execution backend setting".into()),
    }
}

pub(super) fn from_environment() -> Result<Box<dyn ExecutionBackend>, String> {
    select(&|name| std::env::var(name).ok())
}

#[cfg(all(test, unix))]
#[path = "execution_backend_tests.rs"]
mod tests;
