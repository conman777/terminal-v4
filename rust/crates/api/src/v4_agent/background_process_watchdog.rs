//! A best-effort lifeline for ordinary processes in the command's original group.
//! This is not a sandbox and cannot recover or confirm escaped descendants.
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
};
use tokio::io::AsyncReadExt;

const SUPERVISOR: &str = r#"
exec 8<&0
(
  exec 9>&-
  IFS= read -r ignored <&8 || kill -KILL 0
) </dev/null >/dev/null 2>&1 &
monitor=$!
exec 8<&-
/bin/sh -c "$1" </dev/null 8<&- 9>&- &
task=$!
wait "$task"
result=$?
printf 'E%s\n' "$result" >&9
exec 9>&-
wait "$monitor"
"#;

pub(super) fn prepare(
    command: &str,
) -> io::Result<(tokio::process::Command, tokio::net::UnixStream)> {
    let (status_parent, status_child) = UnixStream::pair()?;
    status_parent.set_nonblocking(true)?;
    let status_parent = tokio::net::UnixStream::from_std(status_parent)?;
    // Reserve a descriptor away from standard streams and the script's fixed fd 9.
    let status_fd = unsafe { libc::fcntl(status_child.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if status_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let status_fd = unsafe { OwnedFd::from_raw_fd(status_fd) };
    let raw_fd = status_fd.as_raw_fd();
    let mut process = tokio::process::Command::new("/bin/sh");
    process.args(["-c", SUPERVISOR, "background-supervisor", command]);
    process.stdin(std::process::Stdio::piped());
    unsafe {
        process.pre_exec(move || {
            // Retain the descriptor in the closure until the child has spawned.
            let _keep_alive = &status_fd;
            if libc::setsid() < 0
                || libc::dup2(raw_fd, 9) < 0
                || libc::fcntl(9, libc::F_SETFD, 0) < 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((process, status_parent))
}

pub(super) async fn exit_code(mut status: tokio::net::UnixStream) -> io::Result<i32> {
    let mut bytes = Vec::with_capacity(5);
    loop {
        let mut byte = [0];
        status.read_exact(&mut byte).await?;
        if byte[0] == b'\n' {
            break;
        }
        if bytes.len() == 4 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid supervisor status",
            ));
        }
        bytes.push(byte[0]);
    }
    let code = std::str::from_utf8(bytes.strip_prefix(b"E").unwrap_or_default())
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid supervisor status"))?;
    Ok(i32::from(code))
}
