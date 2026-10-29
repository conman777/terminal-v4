use std::path::Path;
use tokio::process::Command;

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
    pub(super) fn arguments(&self, root: &Path, command: &str) -> Vec<String> {
        let mut arguments: Vec<String> = ["run", "--rm", "--init"]
            .iter()
            .map(|value| value.to_string())
            .collect();
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
        let mut process = Command::new(&self.program);
        process.args(self.arguments(&root, command)).env_clear();
        for (name, value) in scrubbed_host_environment(&|name| std::env::var_os(name)) {
            process.env(name, value);
        }
        Ok(process)
    }
}

pub(super) struct SshBackend;
impl ExecutionBackend for SshBackend {
    fn name(&self) -> &'static str {
        "ssh"
    }
    fn host_description(&self) -> String {
        "SSH backend (not implemented)".into()
    }
    fn command(&self, _root: &Path, _command: &str) -> Result<Command, String> {
        Err("The SSH execution backend is not implemented".into())
    }
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
        Some("ssh") => Ok(Box::new(SshBackend)),
        Some(_) => Err("Unknown execution backend setting".into()),
    }
}

pub(super) fn from_environment() -> Result<Box<dyn ExecutionBackend>, String> {
    select(&|name| std::env::var(name).ok())
}

#[cfg(all(test, unix))]
#[path = "execution_backend_tests.rs"]
mod tests;
