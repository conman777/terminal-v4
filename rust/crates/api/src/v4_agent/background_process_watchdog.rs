//! A best-effort lifeline for ordinary processes in the command's original group.
//! This is not a sandbox and cannot recover or confirm escaped descendants.
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
};
use tokio::io::AsyncReadExt;

pub(super) const MAX_INPUT_BYTES: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum InputError {
    Invalid,
    Unavailable,
    Uncertain,
}

pub(super) struct InteractiveInput(OwnedFd);

impl InteractiveInput {
    pub(super) fn write(&self, bytes: &[u8]) -> Result<(), InputError> {
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
            return Err(InputError::Invalid);
        }
        // A nonblocking pipe write no larger than POSIX's minimum PIPE_BUF is
        // atomic. Treat an unexpected partial result as uncertain, never retry.
        let written =
            unsafe { libc::write(self.0.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
        if written == bytes.len() as isize {
            Ok(())
        } else if written < 0 {
            Err(InputError::Unavailable)
        } else {
            Err(InputError::Uncertain)
        }
    }
}

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

const INTERACTIVE_SUPERVISOR: &str = r#"
exec 8<&0
(
  exec 9>&- 7<&-
  IFS= read -r ignored <&8 || kill -KILL 0
) </dev/null >/dev/null 2>&1 &
monitor=$!
exec 8<&-
/bin/sh -c "$1" <&7 7<&- 8<&- 9>&- &
task=$!
exec 7<&-
wait "$task"
result=$?
printf 'E%s\n' "$result" >&9
exec 9>&-
wait "$monitor"
"#;

pub(super) fn prepare(
    command: &str,
) -> io::Result<(tokio::process::Command, tokio::net::UnixStream)> {
    prepare_command(command, None)
}

// This channel is not exposed to agent tools until approval and replay handling
// are connected. The watchdog lifeline remains on standard input.
pub(super) fn prepare_interactive(
    command: &str,
) -> io::Result<(
    tokio::process::Command,
    tokio::net::UnixStream,
    InteractiveInput,
)> {
    let (read, write) = std::io::pipe()?;
    let read: OwnedFd = read.into();
    let write: OwnedFd = write.into();
    let flags = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(write.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let duplicate = unsafe { libc::fcntl(read.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let input = unsafe { OwnedFd::from_raw_fd(duplicate) };
    let (process, status) = prepare_command(command, Some(input))?;
    Ok((process, status, InteractiveInput(write)))
}

fn prepare_command(
    command: &str,
    input: Option<OwnedFd>,
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
    let input_fd = input.as_ref().map(AsRawFd::as_raw_fd);
    let mut process = tokio::process::Command::new("/bin/sh");
    process.args([
        "-c",
        if input.is_some() {
            INTERACTIVE_SUPERVISOR
        } else {
            SUPERVISOR
        },
        "background-supervisor",
        command,
    ]);
    process.stdin(std::process::Stdio::piped());
    unsafe {
        process.pre_exec(move || {
            // Retain the descriptor in the closure until the child has spawned.
            let _keep_alive = &status_fd;
            let _keep_input = &input;
            if libc::setsid() < 0
                || libc::dup2(raw_fd, 9) < 0
                || libc::fcntl(9, libc::F_SETFD, 0) < 0
                || input_fd
                    .is_some_and(|fd| libc::dup2(fd, 7) < 0 || libc::fcntl(7, libc::F_SETFD, 0) < 0)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Stdio, time::Duration};
    use tokio::io::AsyncBufReadExt;

    #[tokio::test]
    async fn interactive_input_is_distinct_from_supervisor_lifeline() {
        let (mut command, status, input) =
            prepare_interactive("IFS= read -r line; printf 'received:%s' \"$line\"").unwrap();
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        drop(command);
        input.write(b"hello\n").unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), exit_code(status))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        drop(child.stdin.take());
        let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output.stdout, b"received:hello");
    }

    #[tokio::test]
    async fn losing_lifeline_stops_interactive_command_even_when_input_is_open() {
        let (mut command, _status, input) =
            prepare_interactive("(/bin/sleep 1; printf 'survived\\n') & printf 'started\\n'; wait")
                .unwrap();
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        drop(command);
        let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(3), output.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(line, "started\n");
        drop(child.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        line.clear();
        tokio::time::timeout(Duration::from_secs(3), output.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(line, "");
        drop(input);
    }

    #[tokio::test]
    async fn input_is_bounded_and_does_not_block_when_the_pipe_is_full() {
        let (_command, _status, input) = prepare_interactive("exec /bin/cat").unwrap();
        assert_ne!(
            unsafe { libc::fcntl(input.0.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert!(
            unsafe { libc::fpathconf(input.0.as_raw_fd(), libc::_PC_PIPE_BUF) }
                >= MAX_INPUT_BYTES as libc::c_long
        );
        assert_eq!(input.write(&[]), Err(InputError::Invalid));
        assert_eq!(
            input.write(&vec![b'x'; MAX_INPUT_BYTES + 1]),
            Err(InputError::Invalid)
        );
        let bytes = [b'x'; MAX_INPUT_BYTES];
        let mut accepted = 0;
        for _ in 0..100_000 {
            match input.write(&bytes) {
                Ok(()) => accepted += 1,
                Err(InputError::Unavailable) => break,
                other => panic!("unexpected pipe write result: {other:?}"),
            }
        }
        assert!(accepted > 0 && accepted < 100_000);
        assert_eq!(input.write(&bytes), Err(InputError::Unavailable));
    }
}
