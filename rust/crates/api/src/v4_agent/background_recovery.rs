//! Identity-checked recovery of processes a crashed host left unconfirmed.
//! A saved PID is signalled only when its start time still matches; otherwise
//! the receipt stays unknown for human review. Descendants that left the
//! original process group are out of reach of this policy.
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ProcessIdentity {
    pub pid: i32,
    pub pgid: i32,
    pub started: (i64, i64),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Verdict {
    Killed,
    GroupEmpty,
    Mismatch,
    Unverifiable,
}

impl Verdict {
    pub(super) fn name(self) -> &'static str {
        match self {
            Verdict::Killed => "killed",
            Verdict::GroupEmpty => "group_empty",
            Verdict::Mismatch => "identity_mismatch",
            Verdict::Unverifiable => "unverifiable",
        }
    }

    pub(super) fn resolves(self) -> bool {
        matches!(self, Verdict::Killed | Verdict::GroupEmpty)
    }
}

#[cfg(target_os = "macos")]
fn start_time(pid: i32) -> Option<(i64, i64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size && info.pbi_pid == pid as u32)
        .then_some((info.pbi_start_tvsec as i64, info.pbi_start_tvusec as i64))
}

#[cfg(target_os = "linux")]
fn start_time(pid: i32) -> Option<(i64, i64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.get(stat.rfind(')')? + 2..)?;
    let ticks: i64 = rest.split(' ').nth(19)?.parse().ok()?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot = boot.trim().bytes().fold(0i64, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(i64::from(byte))
    });
    Some((boot, ticks))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start_time(_pid: i32) -> Option<(i64, i64)> {
    None
}

pub(super) fn capture(pid: u32) -> Option<ProcessIdentity> {
    let pid = i32::try_from(pid).ok().filter(|pid| *pid > 1)?;
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid <= 1 {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        pgid,
        started: start_time(pid)?,
    })
}

fn exists(target: i32) -> Result<bool, ()> {
    if unsafe { libc::kill(target, 0) } == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        _ => Err(()),
    }
}

fn group_gone_within(pgid: i32, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        match exists(-pgid) {
            Ok(false) => return true,
            Err(()) => return false,
            Ok(true) if Instant::now() >= deadline => return false,
            Ok(true) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

pub(super) fn verify_and_kill(id: &ProcessIdentity, grace: Duration) -> Verdict {
    if id.pid <= 1 || id.pgid <= 1 {
        return Verdict::Unverifiable;
    }
    match start_time(id.pid) {
        Some(started) if started == id.started => {
            if unsafe { libc::getpgid(id.pid) } != id.pgid {
                return Verdict::Mismatch;
            }
            if unsafe { libc::kill(-id.pgid, libc::SIGKILL) } != 0 {
                return Verdict::Unverifiable;
            }
            if group_gone_within(id.pgid, grace) {
                Verdict::Killed
            } else {
                Verdict::Unverifiable
            }
        }
        Some(_) => Verdict::Mismatch,
        None => match (exists(id.pid), exists(-id.pgid)) {
            (Ok(false), Ok(false)) => Verdict::GroupEmpty,
            _ => Verdict::Unverifiable,
        },
    }
}
