use super::*;
use serde_json::json;
use std::{collections::HashMap, os::unix::fs::PermissionsExt};

fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    move |name| map.get(name).cloned()
}

fn selected(pairs: &[(&str, &str)]) -> Result<String, String> {
    select(&lookup(pairs)).map(|backend| backend.name().to_string())
}

fn fake_docker(dir: &Path, body: &str) -> String {
    let path = dir.join("docker");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

fn docker(program: String, network: bool) -> DockerBackend {
    DockerBackend {
        program,
        image: "fixture-image:1".into(),
        memory: "256m".into(),
        cpus: "0.5".into(),
        pids_limit: 64,
        network,
    }
}

#[test]
fn select_defaults_to_local_and_requires_explicit_docker_opt_in() {
    assert_eq!(selected(&[]), Ok("local".into()));
    assert_eq!(selected(&[(BACKEND_VARIABLE, "local")]), Ok("local".into()));
    assert_eq!(
        selected(&[(BACKEND_VARIABLE, "docker")]),
        Err("Docker execution backend requires an image setting".into())
    );
    assert_eq!(
        selected(&[
            (BACKEND_VARIABLE, "docker"),
            (DOCKER_IMAGE_VARIABLE, "img:1")
        ]),
        Ok("docker".into())
    );
    assert_eq!(selected(&[(BACKEND_VARIABLE, "ssh")]), Ok("ssh".into()));
    assert_eq!(
        selected(&[(BACKEND_VARIABLE, "podman")]),
        Err("Unknown execution backend setting".into())
    );
}

#[test]
fn docker_arguments_mount_workspace_limit_resources_and_default_to_no_network() {
    let backend = docker("docker".into(), false);
    assert_eq!(
        backend.arguments(Path::new("/work/space"), "echo hi"),
        [
            "run",
            "--rm",
            "--init",
            "--network=none",
            "--memory=256m",
            "--cpus=0.5",
            "--pids-limit=64",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pull=never",
            "-v",
            "/work/space:/workspace",
            "-w",
            "/workspace",
            "fixture-image:1",
            "/bin/sh",
            "-c",
            "echo hi"
        ]
    );
    assert!(docker("docker".into(), true)
        .arguments(Path::new("/w"), "x")
        .contains(&"--network=bridge".to_string()));
}

#[test]
fn docker_rejects_option_like_images_and_unmountable_workspaces() {
    let root = tempfile::tempdir().unwrap();
    let mut backend = docker("docker".into(), false);
    backend.image = "--privileged".into();
    assert!(backend.command(root.path(), "true").is_err());
    let colon = root.path().join("a:b");
    std::fs::create_dir(&colon).unwrap();
    assert_eq!(
        docker("docker".into(), false).command(&colon, "true").err(),
        Some("Workspace path cannot be mounted into Docker".into())
    );
}

#[test]
fn host_environment_keeps_only_the_allowlist() {
    let values: HashMap<&str, &str> = HashMap::from([
        ("PATH", "/bin"),
        ("OPENAI_API_KEY", "secret"),
        ("HOME", "/h"),
    ]);
    let environment =
        scrubbed_host_environment(&|name| values.get(name).map(std::ffi::OsString::from));
    assert_eq!(
        environment,
        vec![("PATH", std::ffi::OsString::from("/bin"))]
    );
}

#[tokio::test]
async fn local_backend_matches_prior_behaviour() {
    let root = tempfile::tempdir().unwrap();
    let output = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"pwd"}),
        &LocalBackend,
    )
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["exitCode"], 0);
}

#[tokio::test]
async fn docker_backend_runs_through_a_fake_docker_without_pulling_images() {
    let root = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let log = bin.path().join("args.log");
    let program = fake_docker(
        bin.path(),
        &format!(
            "for a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\necho fake-container-output",
            log.display()
        ),
    );
    let output = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"echo hi"}),
        &docker(program, false),
    )
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["stdout"], "fake-container-output\n");
    let recorded = std::fs::read_to_string(log).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    let canonical = root.path().canonicalize().unwrap();
    assert_eq!(lines[0], "run");
    assert!(lines.contains(&"--pull=never"));
    assert!(lines.contains(&"--network=none"));
    assert!(lines.contains(&format!("{}:/workspace", canonical.display()).as_str()));
    assert_eq!(lines.last(), Some(&"echo hi"));
}

#[tokio::test]
async fn missing_docker_executable_fails_closed_without_running_locally() {
    let root = tempfile::tempdir().unwrap();
    let result = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"touch ran-locally"}),
        &docker("/nonexistent/docker".into(), false),
    )
    .await;
    assert_eq!(result, Err("Cannot start command".into()));
    assert!(!root.path().join("ran-locally").exists());
}

#[tokio::test]
async fn ssh_backend_is_explicitly_not_implemented() {
    let root = tempfile::tempdir().unwrap();
    let result = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"touch ran"}),
        &SshBackend,
    )
    .await;
    assert_eq!(
        result,
        Err("The SSH execution backend is not implemented".into())
    );
    assert!(!root.path().join("ran").exists());
}
