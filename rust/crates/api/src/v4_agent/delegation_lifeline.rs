//! Parent-death lifeline for read-only delegated children.
//!
//! The supervisor gives each child the read end of a pipe as stdin and keeps the
//! write end open for the child's whole lifetime. The kernel closes the write
//! end when the supervisor process ends for any reason, including a crash or
//! `kill -9`; the child then sees end-of-file and kills its own process group.
//! This does not cover a stopped (SIGSTOP) supervisor, and a child that blocks
//! SIGKILL cannot exist. Children never read stdin otherwise.
use std::process::{Command, Stdio};

const ENV: &str = "V4_DELEGATION_LIFELINE";

pub(super) fn arm(command: &mut Command) {
    command.stdin(Stdio::piped()).env(ENV, "1");
}

pub(super) fn watch_parent() -> Result<(), String> {
    if std::env::var_os(ENV).is_none_or(|value| value != "1") {
        return Ok(());
    }
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let is_pipe = unsafe { libc::fstat(libc::STDIN_FILENO, stat.as_mut_ptr()) } == 0
        && matches!(
            unsafe { stat.assume_init() }.st_mode & libc::S_IFMT,
            libc::S_IFIFO | libc::S_IFSOCK
        );
    if !is_pipe {
        terminate_group();
    }
    std::thread::Builder::new()
        .name("delegation-lifeline".into())
        .spawn(|| {
            let mut buffer = [0u8; 64];
            loop {
                let read = unsafe {
                    libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(), buffer.len())
                };
                if read > 0
                    || (read < 0
                        && std::io::Error::last_os_error().kind()
                            == std::io::ErrorKind::Interrupted)
                {
                    continue;
                }
                terminate_group();
            }
        })
        .map(|_| ())
        .map_err(|_| "Cannot watch the delegation supervisor".into())
}

fn terminate_group() -> ! {
    unsafe {
        let pid = libc::getpid();
        if libc::getpgrp() == pid {
            libc::kill(0, libc::SIGKILL);
        }
        libc::kill(pid, libc::SIGKILL);
        libc::_exit(137)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, time::Duration};

    const ROLE: &str = "V4_LIFELINE_FIXTURE_ROLE";
    const PID_FILE: &str = "V4_LIFELINE_FIXTURE_PID";

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn read_pid(path: &Path) -> Option<i32> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    fn wait_until(label: &str, condition: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !condition() {
            assert!(std::time::Instant::now() < deadline, "timed out: {label}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn fixture(role: &str, pid_file: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "v4_agent::delegation_lifeline::tests::lifeline_fixture",
                "--nocapture",
            ])
            .env(ROLE, role)
            .env(PID_FILE, pid_file)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn lifeline_fixture() {
        let Some(role) = std::env::var_os(ROLE) else {
            return;
        };
        let pid_file = std::path::PathBuf::from(std::env::var_os(PID_FILE).unwrap());
        let mut lifeline_holder = None;
        if role == "supervisor" {
            let mut child = fixture("child", &pid_file.with_extension("child"));
            arm(&mut child);
            lifeline_holder = Some(child.spawn().unwrap());
            std::fs::write(&pid_file, std::process::id().to_string()).unwrap();
        } else {
            watch_parent().unwrap();
            std::fs::write(&pid_file, std::process::id().to_string()).unwrap();
        }
        std::thread::sleep(Duration::from_secs(120));
        drop(lifeline_holder);
        std::process::exit(0);
    }

    #[test]
    fn child_dies_when_its_supervisor_is_killed_and_not_before() {
        let dir = tempfile::tempdir().unwrap();
        let supervisor_file = dir.path().join("supervisor.pid");
        let child_file = supervisor_file.with_extension("child");
        let mut supervisor = fixture("supervisor", &supervisor_file).spawn().unwrap();
        wait_until("supervisor and child start", || {
            read_pid(&supervisor_file).is_some() && read_pid(&child_file).is_some()
        });
        let child = read_pid(&child_file).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(alive(child), "a live supervisor keeps its child running");

        supervisor.kill().unwrap();
        supervisor.wait().unwrap();
        wait_until("the orphaned child to exit", || !alive(child));
    }

    #[test]
    fn child_without_a_pipe_lifeline_stops_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let mut command = fixture("child", &pid_file);
        command.env(ENV, "1").stdin(Stdio::null());
        let mut child = command.spawn().unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(read_pid(&pid_file).is_none());
    }
}
