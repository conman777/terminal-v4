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
    assert_eq!(
        selected(&[(BACKEND_VARIABLE, "ssh")]),
        Err("SSH execution backend requires a host setting".into())
    );
    assert_eq!(selected(&ssh_settings()), Ok("ssh".into()));
    assert_eq!(
        selected(&[(BACKEND_VARIABLE, "podman")]),
        Err("Unknown execution backend setting".into())
    );
}

#[test]
fn docker_arguments_mount_workspace_limit_resources_and_default_to_no_network() {
    let backend = docker("docker".into(), false);
    let pid_label = format!("--label=terminal-v4.pid={}", std::process::id());
    let run_label = format!("--label=terminal-v4.run={}", run_id());
    assert_eq!(
        backend.arguments(
            Path::new("/work/space"),
            "echo hi",
            "v4-run-fixture",
            Path::new("/cid/container.id")
        ),
        [
            "run",
            "--rm",
            "--init",
            "--name=v4-run-fixture",
            "--cidfile=/cid/container.id",
            "--label=terminal-v4.app=run-command",
            pid_label.as_str(),
            run_label.as_str(),
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
        .arguments(Path::new("/w"), "x", "n", Path::new("/c"))
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
            "if [ \"$1\" != run ]; then exit 0; fi\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\necho fake-container-output",
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

fn ssh_settings() -> Vec<(&'static str, &'static str)> {
    vec![
        (BACKEND_VARIABLE, "ssh"),
        (SSH_HOST_VARIABLE, "build-box"),
        (SSH_WORKDIR_VARIABLE, "/srv/work"),
    ]
}

fn ssh(program: String, workdir: &str) -> SshBackend {
    SshBackend {
        program,
        host: "build-box".into(),
        user: Some("deploy".into()),
        port: Some(2222),
        identity: Some("/keys/id_fixture".into()),
        known_hosts: Some("/keys/known_hosts".into()),
        workdir: workdir.into(),
        state_dir: "/tmp".into(),
    }
}

const FAKE_SSH: &str = r#"#!/usr/bin/python3
import os, signal, subprocess, sys, threading
STATE = "@STATE@"
args = sys.argv[1:]
with open(STATE + "/args.log", "ab") as f:
    for a in args:
        f.write(a.encode() + b"\0")
last = args[-1]
if os.path.exists(STATE + "/fail-probe") and "v4-cleanup" in last:
    sys.exit(255)
# Model sshd: the remote command is not a descendant of the client process
# and survives the client being killed.
out_r, out_w = os.pipe()
err_r, err_w = os.pipe()
status_r, status_w = os.pipe()
first = os.fork()
if first == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    for descriptor in (out_r, err_r, status_r):
        os.close(descriptor)
    null = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(null, descriptor)
    leader = subprocess.Popen(["/bin/sh", "-c", last], preexec_fn=os.setpgrp,
                              stdin=subprocess.DEVNULL, stdout=out_w, stderr=err_w)
    os.close(out_w)
    os.close(err_w)
    code = leader.wait()
    try:
        os.write(status_w, str(code).encode())
    except OSError:
        pass
    os._exit(0)
os.waitpid(first, 0)
for descriptor in (out_w, err_w, status_w):
    os.close(descriptor)
def relay(source, sink):
    while True:
        chunk = os.read(source, 65536)
        if not chunk:
            return
        sink.write(chunk)
        sink.flush()
threads = [threading.Thread(target=relay, args=(out_r, sys.stdout.buffer)),
           threading.Thread(target=relay, args=(err_r, sys.stderr.buffer))]
for t in threads:
    t.start()
status = b""
while True:
    chunk = os.read(status_r, 64)
    if not chunk:
        break
    status += chunk
for t in threads:
    t.join()
sys.exit(int(status or b"255"))
"#;

struct FakeSsh {
    program: String,
    state: std::path::PathBuf,
    remote: std::path::PathBuf,
    _bin: tempfile::TempDir,
    _state: tempfile::TempDir,
    _remote: tempfile::TempDir,
}
impl FakeSsh {
    fn new() -> Self {
        let bin = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let state_path = state.path().canonicalize().unwrap();
        let program = bin.path().join("ssh");
        std::fs::write(
            &program,
            FAKE_SSH.replace("@STATE@", &state_path.to_string_lossy()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            program: program.to_string_lossy().into_owned(),
            state: state_path,
            remote: remote.path().canonicalize().unwrap(),
            _bin: bin,
            _state: state,
            _remote: remote,
        }
    }

    fn backend(&self) -> SshBackend {
        let mut backend = ssh(self.program.clone(), &self.remote.to_string_lossy());
        backend.state_dir = self.remote.to_string_lossy().into_owned();
        backend
    }

    fn pidfiles(&self) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(&self.remote)
            .unwrap()
            .filter_map(|entry| {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                name.starts_with(".v4-run-").then_some(name)
            })
            .collect();
        found.sort();
        found
    }

    fn pid(&self, name: &str) -> i32 {
        std::fs::read_to_string(self.remote.join(name))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    async fn wait_for_pid(&self, name: &str) -> i32 {
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(self.remote.join(name)) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("remote command never started");
    }

    fn probe(&self, backend: &SshBackend, pidfile: &str) -> String {
        let output = std::process::Command::new(&self.program)
            .args(backend.cleanup_arguments(pidfile))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    }
}

#[test]
fn ssh_settings_are_validated_and_fail_closed() {
    let mut pairs = ssh_settings();
    pairs.push((SSH_PORT_VARIABLE, "0"));
    assert_eq!(
        selected(&pairs),
        Err("SSH execution backend port is invalid".into())
    );
    for (variable, bad) in [
        (SSH_HOST_VARIABLE, "-oProxyCommand=touch pwned"),
        (SSH_HOST_VARIABLE, "host name"),
        (SSH_HOST_VARIABLE, "user@host"),
        (SSH_USER_VARIABLE, "-l"),
        (SSH_IDENTITY_VARIABLE, "relative/key"),
        (SSH_KNOWN_HOSTS_VARIABLE, "/with space/known"),
        (SSH_WORKDIR_VARIABLE, "~/work"),
        (SSH_WORKDIR_VARIABLE, "/a\nb"),
    ] {
        let mut pairs: Vec<(&str, &str)> = ssh_settings()
            .into_iter()
            .filter(|(name, _)| *name != variable)
            .collect();
        pairs.push((variable, bad));
        assert_eq!(
            selected(&pairs),
            Err("SSH execution backend settings are invalid".into()),
            "{variable}={bad}"
        );
    }
    assert_eq!(
        selected(&[(BACKEND_VARIABLE, "ssh"), (SSH_HOST_VARIABLE, "h")]),
        Err("SSH execution backend requires a remote directory setting".into())
    );
}

#[test]
fn ssh_arguments_are_non_interactive_strict_and_forward_nothing() {
    let arguments = ssh("ssh".into(), "/srv/it's").arguments("echo 'a b'", "/tmp/.v4-run-x.pid");
    let (script, options) = arguments.split_last().unwrap();
    assert_eq!(
        options,
        [
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
            "-o",
            "IdentitiesOnly=yes",
            "-i",
            "/keys/id_fixture",
            "-o",
            "UserKnownHostsFile=/keys/known_hosts",
            "-p",
            "2222",
            "-l",
            "deploy",
            "--",
            "build-box",
        ]
    );
    assert!(script.starts_with("exec /bin/sh -c '"), "{script}");
    assert!(script.contains("/tmp/.v4-run-x.pid"));
    assert!(script.contains("kill -KILL -$$"));
}

#[test]
fn ssh_approval_discloses_remote_cleanup_limits() {
    let description = ssh("ssh".into(), "/srv/work").host_description();
    assert!(description.contains("remote watchdog"), "{description}");
    assert!(description.contains("may escape"), "{description}");
    assert!(description.contains("unconfirmed"), "{description}");
}

#[tokio::test]
async fn ssh_remote_command_survives_hostile_quoting_through_a_fake_ssh() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let command = "pwd; printf '%s|' \"it's\" '$(touch injected)' `echo tick`; printf 'a\nb'";
    let output = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":command}),
        &backend,
    )
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(
        value["stdout"],
        format!(
            "{}\nit's|$(touch injected)|tick|a\nb",
            fake.remote.display()
        )
    );
    assert!(!fake.remote.join("injected").exists());
    assert!(!root.path().join("injected").exists());
    let recorded = std::fs::read(fake.state.join("args.log")).unwrap();
    let arguments: Vec<&[u8]> = recorded.split(|b| *b == 0).collect();
    assert!(arguments.contains(&b"BatchMode=yes".as_slice()));
    assert!(arguments.contains(&b"StrictHostKeyChecking=yes".as_slice()));
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn ssh_exit_status_and_output_pass_through_and_cleanup_runs_after_success() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let output = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"echo out; echo err >&2; exit 7"}),
        &fake.backend(),
    )
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["exitCode"], 7);
    assert_eq!(value["stdout"], "out\n");
    assert_eq!(value["stderr"], "err\n");
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn fake_ssh_remote_survives_its_killed_client_until_the_probe_runs() {
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let pidfile = fake.remote.join(".v4-run-manual.pid");
    let pidfile_text = pidfile.to_string_lossy().into_owned();
    let mut client = std::process::Command::new(&fake.program)
        .args(backend.arguments("echo $$ > pid; exec sleep 300", &pidfile_text))
        .spawn()
        .unwrap();
    let remote = fake.wait_for_pid("pid").await;
    client.kill().unwrap();
    client.wait().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        alive(remote),
        "the fixture must model a remote that outlives its client"
    );
    assert_eq!(fake.probe(&backend, &pidfile_text).trim(), PROBE_GONE);
    assert_dead(remote).await;
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn ssh_timeout_kills_and_verifies_the_remote_process() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let started = std::time::Instant::now();
    let result = super::super::tools::run_command_with_backend_controls(
        root.path(),
        &json!({"command":"echo $$ > pid; exec sleep 300"}),
        &fake.backend(),
        std::time::Duration::from_secs(1),
        &super::super::interaction::Cancellation::default(),
    )
    .await;
    assert_eq!(result, Err("Command timed out after 1 seconds".into()));
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
    assert_dead(fake.pid("pid")).await;
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn ssh_cancellation_kills_remote_descendants_in_the_remote_group() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let cancel = super::super::interaction::Cancellation::default();
    let input =
        json!({"command":"echo $$ > leader; sleep 300 & echo $! > child; sleep 300 & wait"});
    let (result, ()) = tokio::join!(
        super::super::tools::run_command_with_backend_controls(
            root.path(),
            &input,
            &backend,
            std::time::Duration::from_secs(30),
            &cancel,
        ),
        async {
            fake.wait_for_pid("child").await;
            cancel.cancel();
        }
    );
    assert_eq!(result, Err("Turn cancelled".into()));
    assert_dead(fake.pid("leader")).await;
    assert_dead(fake.pid("child")).await;
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn dropping_the_ssh_run_future_still_kills_the_remote_process() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let input = json!({"command":"echo $$ > pid; exec sleep 300"});
    let cancel = super::super::interaction::Cancellation::default();
    let remote = {
        let run = super::super::tools::run_command_with_backend_controls(
            root.path(),
            &input,
            &backend,
            std::time::Duration::from_secs(30),
            &cancel,
        );
        tokio::pin!(run);
        tokio::select! {
            _ = &mut run => panic!("finished early"),
            pid = fake.wait_for_pid("pid") => pid,
        }
    };
    assert_dead(remote).await;
    assert_eq!(fake.pidfiles(), Vec::<String>::new());
}

#[tokio::test]
async fn unconfirmed_ssh_cleanup_stays_owned_blocks_later_commands_and_can_be_retried() {
    let root = tempfile::tempdir().unwrap();
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let resources = super::super::tools::CommandResources::default();
    std::fs::write(fake.state.join("fail-probe"), "").unwrap();
    let result = super::super::tools::run_command_with_resources_for_test(
        root.path(),
        &json!({"command":"echo $$ > pid; exec sleep 300"}),
        &backend,
        Duration::from_secs(3),
        &resources,
    )
    .await;
    assert_eq!(result, Err("Remote command cleanup is unconfirmed".into()));
    assert!(!resources.is_confirmed());
    let remote = fake.wait_for_pid("pid").await;
    assert!(alive(remote));
    let second = super::super::tools::run_command_with_resources_for_test(
        root.path(),
        &json!({"command":"echo should-not-run > ran"}),
        &backend,
        Duration::from_secs(1),
        &resources,
    )
    .await;
    assert!(second.unwrap_err().contains("Previous command cleanup"));
    assert!(!fake.remote.join("ran").exists());
    std::fs::remove_file(fake.state.join("fail-probe")).unwrap();
    resources.close().await.unwrap();
    assert!(resources.is_confirmed());
    assert_dead(remote).await;
}

#[test]
fn ssh_cleanup_before_start_leaves_a_stop_marker_that_refuses_a_late_command() {
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let pidfile = fake
        .remote
        .join(".v4-run-early.pid")
        .to_string_lossy()
        .into_owned();
    assert_eq!(fake.probe(&backend, &pidfile).trim(), PROBE_ABSENT);
    let late = std::process::Command::new(&fake.program)
        .args(backend.arguments("echo ran > ran", &pidfile))
        .output()
        .unwrap();
    assert_eq!(late.status.code(), Some(125));
    assert!(!fake.remote.join("ran").exists());
}

#[test]
fn ssh_probe_rejects_a_corrupt_pidfile_instead_of_signalling_arbitrary_groups() {
    let fake = FakeSsh::new();
    let backend = fake.backend();
    for (index, content) in ["", "1", "0", "12x", "-1", "$(touch hacked)"]
        .iter()
        .enumerate()
    {
        let pidfile = fake.remote.join(format!(".v4-run-bad{index}.pid"));
        std::fs::write(&pidfile, content).unwrap();
        let output = std::process::Command::new(&fake.program)
            .args(backend.cleanup_arguments(&pidfile.to_string_lossy()))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(4), "{content}");
        assert!(!String::from_utf8_lossy(&output.stdout).contains(PROBE_GONE));
    }
    assert!(!fake.remote.join("hacked").exists());
}

#[tokio::test]
async fn remote_watchdog_kills_the_group_when_no_cleanup_ever_arrives() {
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let pidfile = fake
        .remote
        .join(".v4-run-watch.pid")
        .to_string_lossy()
        .into_owned();
    let script = backend.run_script_with(
        "echo $$ > pid; sleep 300 & echo $! > child; wait",
        &pidfile,
        1,
    );
    let mut client = std::process::Command::new(&fake.program)
        .args(backend.remote_arguments(&script))
        .spawn()
        .unwrap();
    let leader = fake.wait_for_pid("pid").await;
    let child = fake.wait_for_pid("child").await;
    client.kill().unwrap();
    client.wait().unwrap();
    assert_dead(leader).await;
    assert_dead(child).await;
}

#[test]
fn ssh_wrapper_refuses_to_run_when_it_is_not_its_own_process_group_leader() {
    let fake = FakeSsh::new();
    let backend = fake.backend();
    let pidfile = fake
        .remote
        .join(".v4-run-shared.pid")
        .to_string_lossy()
        .into_owned();
    let script = backend.run_script("echo ran > ran", &pidfile);
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("/bin/sh -c {}; exit $?", shell_quote(&script)))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(125));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not isolated"));
    assert!(!fake.remote.join("ran").exists());
    assert!(!fake.remote.join(".v4-run-shared.pid").exists());
}

#[tokio::test]
async fn real_sshd_loopback_runs_a_quoted_command_when_enabled() {
    if std::env::var("V4_TEST_LOOPBACK_SSHD").as_deref() != Ok("1") {
        eprintln!("skipped: set V4_TEST_LOOPBACK_SSHD=1 to run against a private loopback sshd");
        return;
    }
    let dir = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let keygen = |key: &Path| {
        let status = std::process::Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(key)
            .status()
            .unwrap();
        assert!(status.success());
    };
    let host_key = dir.join("host_key");
    let client_key = dir.join("client_key");
    keygen(&host_key);
    keygen(&client_key);
    std::fs::copy(dir.join("client_key.pub"), dir.join("authorized_keys")).unwrap();
    let port = (3041u16..3100)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .unwrap();
    let user = std::env::var("USER").unwrap();
    let config = dir.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "ListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\nPidFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers {user}\nLogLevel ERROR\n",
            host_key.display(),
            dir.join("authorized_keys").display(),
            dir.join("sshd.pid").display(),
        ),
    )
    .unwrap();
    let mut sshd = std::process::Command::new("/usr/sbin/sshd")
        .args(["-D", "-e", "-f"])
        .arg(&config)
        .args(["-p", &port.to_string()])
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let key_line = std::fs::read_to_string(dir.join("host_key.pub")).unwrap();
    let mut fields = key_line.split_whitespace();
    let known_hosts = dir.join("known_hosts");
    std::fs::write(
        &known_hosts,
        format!(
            "[127.0.0.1]:{port} {} {}\n",
            fields.next().unwrap(),
            fields.next().unwrap()
        ),
    )
    .unwrap();
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let workdir = dir.join("work dir's");
    std::fs::create_dir(&workdir).unwrap();
    let backend = SshBackend {
        program: "/usr/bin/ssh".into(),
        host: "127.0.0.1".into(),
        user: Some(user),
        port: Some(port),
        identity: Some(client_key.to_string_lossy().into_owned()),
        known_hosts: Some(known_hosts.to_string_lossy().into_owned()),
        workdir: workdir.to_string_lossy().into_owned(),
        state_dir: dir.to_string_lossy().into_owned(),
    };
    let root = tempfile::tempdir().unwrap();
    let result = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"pwd; printf '%s' \"it's $(echo ok)\"; echo \"[$SSH_AUTH_SOCK]\""}),
        &backend,
    )
    .await;
    let empty_known_hosts = dir.join("empty_known_hosts");
    std::fs::write(&empty_known_hosts, "").unwrap();
    let mut unknown = backend.clone();
    unknown.known_hosts = Some(empty_known_hosts.to_string_lossy().into_owned());
    let unknown_host = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"touch should-not-run"}),
        &unknown,
    )
    .await;
    let timed_out = super::super::tools::run_command_with_backend_controls(
        root.path(),
        &json!({"command":"echo $$ > pid; sleep 300 & echo $! > child; wait"}),
        &backend,
        std::time::Duration::from_secs(2),
        &super::super::interaction::Cancellation::default(),
    )
    .await;
    let survivors: Vec<i32> = ["pid", "child"]
        .iter()
        .filter_map(|name| std::fs::read_to_string(workdir.join(name)).ok())
        .filter_map(|text| text.trim().parse().ok())
        .collect();
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with(".v4-run-"))
        .collect();
    let _ = sshd.kill();
    let _ = sshd.wait();
    assert_eq!(timed_out, Err("Command timed out after 2 seconds".into()));
    assert_eq!(survivors.len(), 2);
    for pid in survivors {
        assert_dead(pid).await;
    }
    assert_eq!(leftovers, Vec::<String>::new());
    let value: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(
        value["stdout"],
        format!("{}\nit's ok[]\n", workdir.display())
    );
    assert_eq!(
        unknown_host,
        Err("Remote command cleanup is unconfirmed".into())
    );
    assert!(!workdir.join("should-not-run").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

const FAKE_DOCKER: &str = r#"#!/usr/bin/python3
import json, os, signal, subprocess, sys, time
STATE = "@STATE@"
args = sys.argv[1:]
with open(STATE + "/calls.log", "a") as f:
    f.write(json.dumps(args) + "\n")

def meta_path(name):
    return f"{STATE}/{name}.json"

def resolve(target):
    for entry in os.listdir(STATE):
        if entry.endswith(".json"):
            meta = json.load(open(f"{STATE}/{entry}"))
            if target in (meta["name"], meta["id"]):
                return meta
    return None

def destroy(target):
    meta = resolve(target)
    if meta is None:
        return False
    try:
        os.killpg(meta["pid"], signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.unlink(meta_path(meta["name"]))
    except FileNotFoundError:
        pass
    return True

def label_values(opts):
    labels = {}
    for index, a in enumerate(opts):
        value = None
        if a.startswith("--label="):
            value = a[len("--label="):]
        elif a == "--label":
            value = opts[index + 1]
        if value is not None:
            key, _, val = value.partition("=")
            labels[key] = val
    return labels

if args[0] == "kill":
    if os.path.exists(STATE + "/fail-cleanup"):
        sys.exit(1)
    sys.exit(0 if destroy(args[1]) else 1)
if args[0] == "rm":
    if os.path.exists(STATE + "/fail-cleanup"):
        sys.exit(1)
    ok = all(destroy(t) for t in args[1:] if not t.startswith("-"))
    sys.exit(0 if ok else 1)
if args[0] == "ps":
    wanted = None
    name_filter = None
    for index, a in enumerate(args):
        if a == "--filter":
            filt = args[index + 1]
            if filt.startswith("label="):
                wanted = filt[len("label="):]
            elif filt.startswith("name=^/") and filt.endswith("$"):
                name_filter = filt[len("name=^/"):-1]
    for entry in sorted(os.listdir(STATE)):
        if entry.endswith(".json"):
            meta = json.load(open(f"{STATE}/{entry}"))
            labels = meta["labels"]
            if name_filter is not None and name_filter != meta["name"]:
                continue
            if wanted is None or wanted in [f"{k}={v}" if v else k for k, v in labels.items()]:
                if name_filter is not None:
                    print(meta["name"])
                else:
                    print("\t".join([meta["id"], labels.get("terminal-v4.pid", ""), labels.get("terminal-v4.run", "")]))
    sys.exit(0)
if args[0] != "run":
    sys.exit(2)

opts = args[1:]
name = cidfile = None
detach = False
index = 0
while index < len(opts):
    a = opts[index]
    if a.startswith("--name="):
        name = a[7:]
    elif a.startswith("--cidfile="):
        cidfile = a[10:]
    elif a == "-d":
        detach = True
    elif a in ("-v", "-w", "--label"):
        index += 1
    elif a.startswith("-"):
        pass
    else:
        break
    index += 1
command = opts[index + 1:]
identifier = name.encode().hex()
delay = float(open(STATE + "/slow-create").read()) if os.path.exists(STATE + "/slow-create") else 0
if cidfile and not delay:
    with open(cidfile, "w") as f:
        f.write(identifier)
labels = label_values(opts)
read_end, write_end = os.pipe()
if os.fork() == 0:
    os.setsid()
    devnull = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(devnull, descriptor)
    if os.fork() == 0:
        os.setpgid(0, 0)
        if delay:
            time.sleep(delay)
            if cidfile:
                with open(cidfile, "w") as f:
                    f.write(identifier)
        json.dump({"name": name, "id": identifier, "pid": os.getpid(), "labels": labels}, open(meta_path(name), "w"))
        os.write(write_end, b"1")
        with open(f"{STATE}/{name}.out", "wb") as out, open(f"{STATE}/{name}.err", "wb") as err:
            code = subprocess.call(command, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        with open(f"{STATE}/{name}.rc", "w") as f:
            f.write(str(code))
        try:
            os.unlink(meta_path(name))
        except FileNotFoundError:
            pass
    os._exit(0)
os.close(write_end)
os.read(read_end, 1)
if detach:
    print(identifier)
    sys.exit(0)
while os.path.exists(meta_path(name)):
    time.sleep(0.05)
if os.path.exists(f"{STATE}/{name}.rc"):
    sys.stdout.write(open(f"{STATE}/{name}.out").read())
    sys.stderr.write(open(f"{STATE}/{name}.err").read())
    sys.exit(int(open(f"{STATE}/{name}.rc").read()))
sys.exit(137)
"#;

struct FakeDaemon {
    program: String,
    state: std::path::PathBuf,
    _bin: tempfile::TempDir,
    _state: tempfile::TempDir,
}
impl FakeDaemon {
    fn new() -> Self {
        let bin = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let state_path = state.path().canonicalize().unwrap();
        let program = fake_docker(bin.path(), "");
        std::fs::write(
            &program,
            FAKE_DOCKER.replace("@STATE@", &state_path.to_string_lossy()),
        )
        .unwrap();
        Self {
            program,
            state: state_path,
            _bin: bin,
            _state: state,
        }
    }

    fn containers(&self) -> Vec<serde_json::Value> {
        let mut found: Vec<serde_json::Value> = std::fs::read_dir(&self.state)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                (path.extension()? == "json")
                    .then(|| serde_json::from_slice(&std::fs::read(path).ok()?).ok())
                    .flatten()
            })
            .collect();
        found.sort_by_key(|meta| meta["name"].as_str().unwrap().to_owned());
        found
    }

    async fn wait_for_container(&self) -> serde_json::Value {
        for _ in 0..200 {
            if let Some(meta) = self.containers().into_iter().next() {
                return meta;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("container never started");
    }

    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.state.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn detached(&self, name: &str, labels: &[&str]) -> i32 {
        let mut command = std::process::Command::new(&self.program);
        command.args(["run", "-d", &format!("--name={name}")]);
        for label in labels {
            command.arg(format!("--label={label}"));
        }
        command.args(["img", "/bin/sh", "-c", "sleep 300"]);
        assert!(command.output().unwrap().status.success());
        let meta: serde_json::Value = serde_json::from_slice(
            &std::fs::read(self.state.join(format!("{name}.json"))).unwrap(),
        )
        .unwrap();
        meta["pid"].as_i64().unwrap() as i32
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn assert_dead(pid: i32) {
    for _ in 0..100 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("process {pid} survived");
}

fn verbs(daemon: &FakeDaemon) -> Vec<String> {
    daemon.calls().iter().map(|call| call[0].clone()).collect()
}

#[tokio::test]
async fn fake_daemon_keeps_a_container_running_after_its_client_is_sigkilled() {
    let daemon = FakeDaemon::new();
    let mut client = std::process::Command::new(&daemon.program)
        .args([
            "run",
            "--name=survivor",
            "img",
            "/bin/sh",
            "-c",
            "sleep 300",
        ])
        .spawn()
        .unwrap();
    let meta = daemon.wait_for_container().await;
    let container = meta["pid"].as_i64().unwrap() as i32;
    client.kill().unwrap();
    client.wait().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(alive(container));
    assert!(std::process::Command::new(&daemon.program)
        .args(["kill", "survivor"])
        .status()
        .unwrap()
        .success());
    assert_dead(container).await;
}

#[tokio::test]
async fn successful_docker_command_confirms_the_container_is_gone() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let output = super::super::tools::run_command_with_backend(
        root.path(),
        &json!({"command":"echo from-container"}),
        &docker(daemon.program.clone(), false),
    )
    .await
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["stdout"], "from-container\n");
    assert_eq!(daemon.containers(), Vec::<serde_json::Value>::new());
    assert_eq!(verbs(&daemon), ["run", "kill", "rm", "rm", "ps"]);
}

#[tokio::test]
async fn docker_run_uses_a_unique_name_cidfile_and_ownership_labels() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    for _ in 0..2 {
        super::super::tools::run_command_with_backend(
            root.path(),
            &json!({"command":"true"}),
            &backend,
        )
        .await
        .unwrap();
    }
    let calls = daemon.calls();
    let names: Vec<&String> = calls
        .iter()
        .filter(|call| call[0] == "run")
        .map(|call| {
            call.iter()
                .find(|a| a.starts_with("--name=v4-run-"))
                .unwrap()
        })
        .collect();
    assert_eq!(names.len(), 2);
    assert_ne!(names[0], names[1]);
    for call in calls.iter().filter(|call| call[0] == "run") {
        assert!(call.contains(&"--label=terminal-v4.app=run-command".to_string()));
        assert!(call.contains(&format!("--label=terminal-v4.pid={}", std::process::id())));
        assert!(call.iter().any(|a| a.starts_with("--cidfile=")));
    }
}

#[tokio::test]
async fn timeout_removes_the_container_that_outlives_its_killed_client() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let result = super::super::tools::run_command_with_backend_controls(
        root.path(),
        &json!({"command":"sleep 300"}),
        &backend,
        std::time::Duration::from_secs(1),
        &super::super::interaction::Cancellation::default(),
    )
    .await;
    assert_eq!(result, Err("Command timed out after 1 seconds".into()));
    assert_eq!(verbs(&daemon), ["run", "kill", "rm", "rm", "ps"]);
    assert_eq!(daemon.containers(), Vec::<serde_json::Value>::new());
}

#[tokio::test]
async fn failed_docker_cleanup_remains_owned_and_can_be_retried() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let resources = super::super::tools::CommandResources::default();
    std::fs::write(daemon.state.join("fail-cleanup"), "").unwrap();
    let result = super::super::tools::run_command_with_resources_for_test(
        root.path(),
        &json!({"command":"sleep 300"}),
        &backend,
        Duration::from_secs(1),
        &resources,
    )
    .await;
    assert_eq!(
        result,
        Err("Docker container cleanup is unconfirmed".into())
    );
    assert!(!resources.is_confirmed());
    assert_eq!(daemon.containers().len(), 1);
    let second = super::super::tools::run_command_with_resources_for_test(
        root.path(),
        &json!({"command":"echo should-not-run"}),
        &backend,
        Duration::from_secs(1),
        &resources,
    )
    .await;
    assert!(second.unwrap_err().contains("Previous command cleanup"));
    std::fs::remove_file(daemon.state.join("fail-cleanup")).unwrap();
    resources.close().await.unwrap();
    assert!(resources.is_confirmed());
    assert!(daemon.containers().is_empty());
}

#[tokio::test]
async fn cancellation_removes_the_running_container() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let cancel = super::super::interaction::Cancellation::default();
    let input = json!({"command":"sleep 300"});
    let (result, container) = tokio::join!(
        super::super::tools::run_command_with_backend_controls(
            root.path(),
            &input,
            &backend,
            std::time::Duration::from_secs(30),
            &cancel,
        ),
        async {
            let meta = daemon.wait_for_container().await;
            let pid = meta["pid"].as_i64().unwrap() as i32;
            assert!(alive(pid));
            cancel.cancel();
            pid
        }
    );
    assert_eq!(result, Err("Turn cancelled".into()));
    assert_dead(container).await;
    assert_eq!(daemon.containers(), Vec::<serde_json::Value>::new());
}

#[tokio::test]
async fn dropping_the_run_future_still_removes_the_container() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let input = json!({"command":"sleep 300"});
    let cancel = super::super::interaction::Cancellation::default();
    let container = {
        let run = super::super::tools::run_command_with_backend_controls(
            root.path(),
            &input,
            &backend,
            std::time::Duration::from_secs(30),
            &cancel,
        );
        tokio::pin!(run);
        let pid = tokio::select! {
            _ = &mut run => panic!("finished early"),
            meta = daemon.wait_for_container() => meta["pid"].as_i64().unwrap() as i32,
        };
        assert!(alive(pid));
        pid
    };
    assert_dead(container).await;
    assert_eq!(daemon.containers(), Vec::<serde_json::Value>::new());
}

#[tokio::test]
async fn cleanup_uses_the_cidfile_identifier_as_well_as_the_name() {
    let daemon = FakeDaemon::new();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let _ = super::super::tools::run_command_with_backend_controls(
        root.path(),
        &json!({"command":"sleep 300"}),
        &backend,
        std::time::Duration::from_secs(1),
        &super::super::interaction::Cancellation::default(),
    )
    .await;
    let calls = daemon.calls();
    let removed: Vec<&String> = calls
        .iter()
        .filter(|call| call[0] == "rm")
        .map(|call| &call[2])
        .collect();
    assert_eq!(removed.len(), 2);
    assert!(removed[0].starts_with("v4-run-"));
    let hex: String = removed[0].bytes().map(|b| format!("{b:02x}")).collect();
    assert_eq!(removed[1], &hex);
}

#[test]
fn dead_run_filter_only_selects_this_apps_containers_from_dead_runs() {
    let listing = "aaa1\t100\trun-old\nbbb2\t200\trun-old\nccc3\t100\trun-now\nddd4\t\trun-old\neee5\tnotapid\trun-old\n--bad\t100\trun-old\nfff6\t100\t\n";
    let alive = |pid: u32| pid == 200;
    assert_eq!(dead_run_container_ids(listing, "run-now", &alive), ["aaa1"]);
}

#[tokio::test]
async fn reaper_removes_only_labelled_containers_of_dead_runs() {
    let daemon = FakeDaemon::new();
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let dead_pid = gone.id();
    gone.wait().unwrap();
    let live_pid = std::process::id();
    let stale = daemon.detached(
        "stale",
        &[
            "terminal-v4.app=run-command",
            &format!("terminal-v4.pid={dead_pid}"),
            "terminal-v4.run=old-run",
        ],
    );
    let other_live_app = daemon.detached(
        "other-live",
        &[
            "terminal-v4.app=run-command",
            &format!("terminal-v4.pid={live_pid}"),
            "terminal-v4.run=another-instance",
        ],
    );
    let current = daemon.detached(
        "current",
        &[
            "terminal-v4.app=run-command",
            &format!("terminal-v4.pid={dead_pid}"),
            &format!("terminal-v4.run={}", run_id()),
        ],
    );
    let foreign = daemon.detached("foreign", &[&format!("terminal-v4.pid={dead_pid}")]);
    let removed = reap_leftover_containers(&daemon.program);
    assert_eq!(removed, 1);
    assert_dead(stale).await;
    for survivor in [other_live_app, current, foreign] {
        assert!(alive(survivor));
    }
    let names: Vec<String> = daemon
        .containers()
        .iter()
        .map(|meta| meta["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["current", "foreign", "other-live"]);
    for name in ["current", "foreign", "other-live"] {
        assert!(std::process::Command::new(&daemon.program)
            .args(["rm", "-f", name])
            .status()
            .unwrap()
            .success());
    }
}

#[test]
fn reaper_without_a_docker_executable_removes_nothing() {
    assert_eq!(reap_leftover_containers("/nonexistent/docker"), 0);
}

#[test]
fn docker_cleanup_does_not_wait_for_descendants_holding_stdout_open() {
    let mut command = scrubbed_std_command("/bin/sh");
    command.args(["-c", "sleep 2 &"]);
    let start = Instant::now();
    let output = bounded_output(command, Duration::from_millis(100));
    assert!(output.is_none());
    assert!(start.elapsed() < Duration::from_millis(1500));
}

#[test]
fn docker_cleanup_rejects_unbounded_stdout() {
    let mut command = scrubbed_std_command("/bin/sh");
    command.args(["-c", "exec yes x"]);
    let start = Instant::now();
    assert!(bounded_output(command, Duration::from_secs(5)).is_none());
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn container_created_after_the_client_was_killed_is_still_removed() {
    let daemon = FakeDaemon::new();
    std::fs::write(daemon.state.join("slow-create"), "1.5").unwrap();
    let root = tempfile::tempdir().unwrap();
    let backend = docker(daemon.program.clone(), false);
    let result = super::super::tools::run_command_with_backend_controls(
        root.path(),
        &json!({"command":"sleep 300"}),
        &backend,
        std::time::Duration::from_secs(1),
        &super::super::interaction::Cancellation::default(),
    )
    .await;
    assert_eq!(result, Err("Command timed out after 1 seconds".into()));
    assert_eq!(daemon.containers(), Vec::<serde_json::Value>::new());
}

#[test]
fn cidfile_contents_that_are_not_container_ids_are_never_passed_to_docker() {
    let daemon = FakeDaemon::new();
    let directory = tempfile::tempdir().unwrap();
    for hostile in ["--all", "$(touch hacked)", "a b", ""] {
        std::fs::write(directory.path().join("container.id"), hostile).unwrap();
        let mut cleanup = ContainerCleanup::docker(
            daemon.program.clone(),
            "v4-run-fixture".into(),
            tempfile::Builder::new().tempdir().unwrap(),
        );
        let CleanupTarget::Docker {
            directory: owned, ..
        } = &cleanup.target
        else {
            unreachable!()
        };
        std::fs::write(owned.path().join("container.id"), hostile).unwrap();
        cleanup.force_remove().unwrap();
    }
    for call in daemon.calls() {
        if call[0] == "rm" {
            assert_eq!(call, ["rm", "-f", "v4-run-fixture"]);
        }
    }
}

#[tokio::test]
async fn failed_reaper_removal_is_not_counted_and_is_retried_on_the_next_restart() {
    let daemon = FakeDaemon::new();
    let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let dead_pid = gone.id();
    gone.wait().unwrap();
    let stale = daemon.detached(
        "stale",
        &[
            "terminal-v4.app=run-command",
            &format!("terminal-v4.pid={dead_pid}"),
            "terminal-v4.run=old-run",
        ],
    );
    std::fs::write(daemon.state.join("fail-cleanup"), "").unwrap();
    assert_eq!(reap_leftover_containers(&daemon.program), 0);
    assert!(alive(stale));
    std::fs::remove_file(daemon.state.join("fail-cleanup")).unwrap();
    assert_eq!(reap_leftover_containers(&daemon.program), 1);
    assert_dead(stale).await;
}

#[test]
fn reaper_with_a_failing_or_garbled_daemon_removes_nothing() {
    let bin = tempfile::tempdir().unwrap();
    assert_eq!(
        reap_leftover_containers(&fake_docker(bin.path(), "exit 1")),
        0
    );
    let garbled = tempfile::tempdir().unwrap();
    assert_eq!(
        reap_leftover_containers(&fake_docker(
            garbled.path(),
            "echo 'not\ta\tlisting\textra'; echo junk"
        )),
        0
    );
}
