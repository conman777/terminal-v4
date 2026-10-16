use std::path::Path;
use tokio::process::Command;

pub(crate) fn supported_task_provider(provider: &str) -> bool {
    ["claude", "codex", "hermes"].contains(&provider)
        || crate::hermes_provider_bridge::provider_mapping(provider).is_some()
}

pub(crate) fn task_command(
    provider: &str,
    prompt: &str,
    model: Option<&str>,
    cwd: &Path,
) -> Result<Command, String> {
    if !["claude", "codex", "hermes"].contains(&provider) {
        return Err("Unsupported task provider".into());
    }
    if prompt.trim().is_empty()
        || prompt.chars().any(|value| value == char::from(0))
        || prompt.chars().count() > 50_000
    {
        return Err("Invalid task prompt".into());
    }
    if model.is_some_and(|model| {
        model.trim().is_empty()
            || model.chars().count() > 200
            || model.chars().any(char::is_control)
    }) {
        return Err("Invalid model".into());
    }
    let command = native_command(provider)
        .ok_or_else(|| format!("{provider} is not installed on this host"))?;
    build_task_command(command, provider, prompt, model, cwd)
}

fn build_task_command(
    mut command: Command,
    provider: &str,
    prompt: &str,
    model: Option<&str>,
    cwd: &Path,
) -> Result<Command, String> {
    command.current_dir(cwd).kill_on_drop(true);
    match provider {
        "claude" => {
            command.args(["-p", prompt, "--output-format", "stream-json", "--verbose"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
        }
        "codex" => {
            command.args(["exec", "--json", "--sandbox", "workspace-write"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            command.args(["--", prompt]);
        }
        "hermes" => {
            command.args(["chat", "--query", prompt, "--quiet"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
        }
        _ => unreachable!(),
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_task_commands_preserve_prompt_as_an_argument_and_use_provider_tools() {
        let prompt = "Inspect the repo; literal $(command) & text";
        let directory = Path::new(".");
        let expected = [
            (
                "claude",
                vec!["-p", prompt, "--output-format", "stream-json", "--verbose"],
            ),
            (
                "codex",
                vec![
                    "exec",
                    "--json",
                    "--sandbox",
                    "workspace-write",
                    "--",
                    prompt,
                ],
            ),
            ("hermes", vec!["chat", "--query", prompt, "--quiet"]),
        ];
        for (provider, arguments) in expected {
            let command =
                build_task_command(Command::new(provider), provider, prompt, None, directory)
                    .unwrap();
            let actual: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(actual, arguments);
            assert_eq!(command.as_std().get_current_dir(), Some(directory));
        }
    }

    #[test]
    fn native_task_commands_reject_unknown_providers_and_invalid_models() {
        assert!(task_command("shell", "task", None, Path::new(".")).is_err());
        assert!(task_command("codex", "task", Some("bad\nmodel"), Path::new(".")).is_err());
    }
}

pub(crate) fn native_command_in(
    provider: &str,
    directories: &[std::path::PathBuf],
    windows: bool,
) -> Option<Command> {
    if !["codex", "claude", "gemini", "hermes", "node"].contains(&provider) {
        return None;
    }
    let filename = if windows {
        format!("{provider}.exe")
    } else {
        provider.to_owned()
    };
    for directory in directories {
        let executable = directory.join(&filename);
        if executable.is_file() {
            return Some(Command::new(executable));
        }
    }
    if windows && ["codex", "gemini"].contains(&provider) {
        let relative = if provider == "codex" {
            "node_modules/@openai/codex/bin/codex.js"
        } else {
            "node_modules/@google/gemini-cli/dist/index.js"
        };
        for directory in directories {
            let script = directory.join(relative);
            if script.is_file() {
                let mut command = native_command_in("node", directories, windows)?;
                command.arg(script);
                return Some(command);
            }
        }
    }
    None
}

#[cfg(test)]
mod resolution_tests {
    use super::*;
    #[test]
    fn windows_npm_codex_uses_node_without_a_command_shell() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "// fixture").unwrap();
        std::fs::write(root.path().join("node.exe"), "fixture").unwrap();
        std::fs::write(root.path().join("codex.cmd"), "unsafe shell wrapper").unwrap();
        let command = native_command_in("codex", &[root.path().into()], true).unwrap();
        assert_eq!(command.as_std().get_program(), root.path().join("node.exe"));
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            vec![script.as_os_str()]
        );
    }
    #[test]
    fn windows_does_not_treat_arbitrary_shell_wrappers_as_native_executables() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("hermes.cmd"), "fixture").unwrap();
        std::fs::write(root.path().join("hermes.ps1"), "fixture").unwrap();
        assert!(native_command_in("hermes", &[root.path().into()], true).is_none());
    }
}

pub(crate) fn native_command(provider: &str) -> Option<Command> {
    if provider == "hermes" {
        if let Some(executable) = std::env::var_os("HERMES_EXECUTABLE") {
            let path = std::path::PathBuf::from(executable);
            let extension_valid = !cfg!(windows)
                || path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
            if path.is_absolute() && path.is_file() && extension_valid {
                return Some(Command::new(path));
            }
        }
    }
    let directories: Vec<_> = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    native_command_in(provider, &directories, cfg!(windows))
}

pub(crate) fn native_launch_command(command: &Command) -> Option<String> {
    let parts = std::iter::once(command.as_std().get_program()).chain(command.as_std().get_args());
    let mut quoted = Vec::new();
    for value in parts {
        let value = value.to_str()?;
        if value.chars().any(char::is_control) {
            return None;
        }
        if cfg!(windows) {
            if value.contains(['"', '%', '!']) {
                return None;
            }
            quoted.push(format!("\"{value}\""));
        } else {
            quoted.push(format!("'{}'", value.replace(char::from(39), "'\"'\"'")));
        }
    }
    Some(quoted.join(" "))
}
