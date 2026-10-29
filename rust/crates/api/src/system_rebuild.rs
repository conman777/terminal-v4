use std::path::PathBuf;

pub(crate) struct RebuildConfig {
    project_root: PathBuf,
    script: Option<PathBuf>,
    windows_ps1: Option<PathBuf>,
    windows_cmd: Option<PathBuf>,
}

pub(crate) struct RebuildCommand {
    pub program: &'static str,
    pub args: Vec<PathBuf>,
    pub project_root: PathBuf,
}

impl RebuildConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            project_root: std::env::var_os("REBUILD_PROJECT_ROOT")
                .or_else(|| std::env::var_os("TERMINAL_V4_RUNTIME_ROOT"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")),
            script: std::env::var_os("REBUILD_SCRIPT_PATH").map(PathBuf::from),
            windows_ps1: std::env::var_os("REBUILD_SCRIPT_WINDOWS_PS1").map(PathBuf::from),
            windows_cmd: std::env::var_os("REBUILD_SCRIPT_WINDOWS_CMD").map(PathBuf::from),
        }
    }

    pub(crate) fn command(self, windows: bool) -> Result<RebuildCommand, String> {
        let project_root = self
            .project_root
            .canonicalize()
            .map_err(|error| format!("Invalid rebuild project root: {error}"))?;
        if !project_root.is_dir() {
            return Err("Rebuild project root must be a directory".into());
        }
        let script = project_root.join(self.script.unwrap_or_else(|| PathBuf::from("rebuild.sh")));
        let (program, args) = if windows {
            let ps1 = project_root.join(
                self.windows_ps1
                    .unwrap_or_else(|| PathBuf::from("rebuild.ps1")),
            );
            let cmd = project_root.join(
                self.windows_cmd
                    .unwrap_or_else(|| PathBuf::from("rebuild.cmd")),
            );
            if ps1.is_file() {
                (
                    "powershell.exe",
                    vec![PathBuf::from("-NoProfile"), PathBuf::from("-File"), ps1],
                )
            } else if cmd.is_file() {
                ("cmd.exe", vec![PathBuf::from("/c"), cmd])
            } else if script.is_file() {
                ("bash", vec![script])
            } else {
                return Err("Rebuild script not found. Set REBUILD_PROJECT_ROOT or a REBUILD_SCRIPT_* override.".into());
            }
        } else if script.is_file() {
            ("bash", vec![script])
        } else {
            return Err(
                "Rebuild script not found. Set REBUILD_SCRIPT_PATH or REBUILD_PROJECT_ROOT.".into(),
            );
        };
        Ok(RebuildCommand {
            program,
            args,
            project_root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "terminal-rebuild-plan-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn explicit_unix_script_and_project_are_not_replaced_by_runtime_cwd() {
        let root = fixture();
        let script = root.join("custom build.sh");
        std::fs::write(&script, "printf synthetic").unwrap();
        let config = RebuildConfig {
            project_root: root.clone(),
            script: Some(PathBuf::from("custom build.sh")),
            windows_ps1: None,
            windows_cmd: None,
        };
        let command = config.command(false).unwrap();
        assert_eq!(
            (command.program, command.args, command.project_root),
            ("bash", vec![script], root.canonicalize().unwrap())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_selects_configured_powershell_then_cmd_and_fails_when_no_script_exists() {
        let root = fixture();
        let ps1 = root.join("custom.ps1");
        let cmd = root.join("custom.cmd");
        std::fs::write(&ps1, "Write-Output synthetic").unwrap();
        std::fs::write(&cmd, "echo synthetic").unwrap();
        let config = || RebuildConfig {
            project_root: root.clone(),
            script: None,
            windows_ps1: Some(ps1.clone()),
            windows_cmd: Some(cmd.clone()),
        };
        let command = config().command(true).unwrap();
        assert_eq!(
            (command.program, command.args),
            (
                "powershell.exe",
                vec![
                    PathBuf::from("-NoProfile"),
                    PathBuf::from("-File"),
                    ps1.clone()
                ]
            )
        );
        std::fs::remove_file(&ps1).unwrap();
        let command = config().command(true).unwrap();
        assert_eq!(
            (command.program, command.args),
            ("cmd.exe", vec![PathBuf::from("/c"), cmd.clone()])
        );
        std::fs::remove_file(&cmd).unwrap();
        assert!(config().command(true).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn selected_script_receives_the_project_directory_and_preserves_failure_output() {
        let root = fixture();
        std::fs::write(
            root.join("rebuild.sh"),
            "pwd; printf 'synthetic build failure' >&2; exit 7",
        )
        .unwrap();
        let command = RebuildConfig {
            project_root: root.clone(),
            script: None,
            windows_ps1: None,
            windows_cmd: None,
        }
        .command(false)
        .unwrap();
        let output = std::process::Command::new(command.program)
            .args(command.args)
            .current_dir(&command.project_root)
            .output()
            .unwrap();
        assert_eq!(
            (
                output.status.code(),
                String::from_utf8(output.stdout).unwrap().trim().to_string(),
                String::from_utf8(output.stderr).unwrap()
            ),
            (
                Some(7),
                root.to_string_lossy().into_owned(),
                "synthetic build failure".into()
            )
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
