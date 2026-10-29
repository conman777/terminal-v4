use std::io;
use std::time::Duration;

#[cfg(unix)]
mod unix {
    use super::*;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct Identity {
        pid: i32,
        parent: i32,
        born: (u64, u64),
        alive: bool,
        group: i32,
    }

    impl Identity {
        fn current(self) -> bool {
            process_info(self.pid).is_some_and(|now| now.born == self.born)
        }

        fn signal(self, signal: i32) {
            // Checking the birth identity avoids signalling a recycled PID. Never
            // signal a whole process group: it can contain processes we do not own.
            if self.pid > 1 && self.pid != std::process::id() as i32 && self.current() {
                unsafe {
                    libc::kill(self.pid, signal);
                }
            }
        }
    }

    struct Tracked {
        members: HashMap<i32, Identity>,
        owned_group: Option<OwnedGroup>,
    }

    #[derive(Clone, Copy)]
    struct OwnedGroup {
        id: i32,
        leader: Option<Identity>,
        unreaped: bool,
    }

    impl Tracked {
        fn refresh(&mut self) {
            if let Some(group) = self.owned_group {
                let leader_now = inspect_process(group.id);
                let leader_reused = group
                    .leader
                    .zip(leader_now)
                    .is_some_and(|(owned, now)| owned.born != now.born);
                let leader_matches = group
                    .leader
                    .zip(leader_now)
                    .is_some_and(|(owned, now)| owned.born == now.born);
                let member_matches = self.members.values().any(|owned| {
                    process_info(owned.pid)
                        .is_some_and(|now| now.born == owned.born && now.group == group.id)
                });
                // A fresh child cannot have its PID recycled before its owner reaps
                // it. After reaping, group discovery requires a surviving identity.
                if !leader_reused && (group.unreaped || leader_matches || member_matches) {
                    for pid in group_pids(group.id) {
                        if let Some(member) =
                            process_info(pid).filter(|member| member.group == group.id)
                        {
                            self.members.insert(pid, member);
                        }
                    }
                } else {
                    self.owned_group = None;
                }
            }
            self.members
                .retain(|_, member| match inspect_process(member.pid) {
                    Some(current) => current.alive && current.born == member.born,
                    None => process_exists(member.pid),
                });
            let mut queue: VecDeque<Identity> = self.members.values().copied().collect();
            let mut checked = HashSet::new();
            while let Some(parent) = queue.pop_front() {
                if !checked.insert(parent.pid) || !parent.current() {
                    continue;
                }
                for pid in child_pids(parent.pid) {
                    let Some(child) = process_info(pid) else {
                        continue;
                    };
                    if child.parent != parent.pid || !parent.current() {
                        continue;
                    }
                    self.members.insert(pid, child);
                    queue.push_back(child);
                }
            }
            if self.members.is_empty() {
                self.owned_group = None;
            }
        }

        fn freeze(&mut self) {
            // Freeze known members before repeated discovery so fork/setsid children do
            // not escape simply by changing process group during controlled stop.
            for _ in 0..8 {
                let previous = self.members.len();
                for member in self.members.values() {
                    member.signal(libc::SIGSTOP);
                }
                self.refresh();
                if self.members.len() == previous {
                    for member in self.members.values() {
                        member.signal(libc::SIGSTOP);
                    }
                    self.refresh();
                    if self.members.len() == previous {
                        break;
                    }
                }
            }
        }

        fn force_stop(&mut self) {
            self.freeze();
            for member in self.members.values() {
                member.signal(libc::SIGKILL);
            }
        }
    }

    struct Guard {
        tracked: Mutex<Tracked>,
        stopping: Mutex<()>,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            if let Ok(tracked) = self.tracked.get_mut() {
                tracked.force_stop();
            }
        }
    }

    #[derive(Clone)]
    pub(crate) struct ProcessTree {
        guard: Arc<Guard>,
    }

    impl ProcessTree {
        pub(crate) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            Self::attach_pid(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("Process already exited"))?,
            )
        }

        pub(crate) fn attach_pid(pid: u32) -> io::Result<Self> {
            Self::attach_inner(pid, false)
        }

        /// Attach immediately after spawning with process_group(0). Reap the
        /// child through wait or try_wait so group discovery precedes PID release.
        /// The owned group survives a rapid leader exit; observed children can
        /// also be tracked across setsid. A child that daemonizes into another
        /// session before any observation needs OS containment beyond this tracker.
        pub(crate) fn attach_new_process_group(child: &tokio::process::Child) -> io::Result<Self> {
            Self::attach_inner(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("Process already exited"))?,
                true,
            )
        }

        /// portable-pty's Unix spawn uses setsid, creating a fresh owned group.
        /// Only use with its unreaped direct child and reap via try_wait_pty.
        pub(crate) fn attach_pty(child: &dyn portable_pty::Child) -> io::Result<Self> {
            Self::attach_inner(
                child
                    .process_id()
                    .ok_or_else(|| io::Error::other("Process ID unavailable"))?,
                true,
            )
        }

        pub(crate) fn try_wait_pty(
            &self,
            child: &mut dyn portable_pty::Child,
        ) -> io::Result<Option<portable_pty::ExitStatus>> {
            let pid = child
                .process_id()
                .ok_or_else(|| io::Error::other("Process ID unavailable"))?;
            let mut tracked = self
                .guard
                .tracked
                .lock()
                .map_err(|_| io::Error::other("Process tracking lock failed"))?;
            let mut exited: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // Observe exit without releasing the PID. Once exited the leader
            // cannot fork, and its group cannot be recycled before this snapshot.
            let observed = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut exited,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if observed != 0 {
                return Err(io::Error::last_os_error());
            }
            tracked.refresh();
            if unsafe { exited.si_pid() } != pid as i32 {
                return Ok(None);
            }
            let status = child.try_wait()?;
            if status.is_some() {
                if let Some(group) = &mut tracked.owned_group {
                    group.unreaped = false;
                }
                tracked.refresh();
            }
            Ok(status)
        }

        fn attach_inner(pid: u32, own_group: bool) -> io::Result<Self> {
            let pid = i32::try_from(pid)
                .ok()
                .filter(|pid| *pid > 1 && *pid != std::process::id() as i32)
                .ok_or_else(|| io::Error::other("Invalid owned process identifier"))?;
            let mut members = HashMap::new();
            let leader = inspect_process(pid);
            if own_group && leader.is_some_and(|identity| identity.group != pid) {
                return Err(io::Error::other(
                    "Owned process was not spawned in its own process group",
                ));
            }
            match leader {
                Some(identity) if identity.alive => {
                    members.insert(pid, identity);
                }
                Some(_) => {}
                None if process_exists(pid) => {
                    return Err(io::Error::other(
                        "Owned process identity could not be inspected",
                    ))
                }
                None => {}
            }
            let guard = Arc::new(Guard {
                tracked: Mutex::new(Tracked {
                    members,
                    owned_group: own_group.then_some(OwnedGroup {
                        id: pid,
                        leader,
                        unreaped: true,
                    }),
                }),
                stopping: Mutex::new(()),
            });
            guard
                .tracked
                .lock()
                .map_err(|_| io::Error::other("Process tracking lock failed"))?
                .refresh();
            let weak = Arc::downgrade(&guard);
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let mut tick = tokio::time::interval(Duration::from_millis(50));
                    loop {
                        tick.tick().await;
                        let Some(guard) = weak.upgrade() else {
                            break;
                        };
                        let empty = guard
                            .tracked
                            .lock()
                            .map(|mut state| {
                                state.refresh();
                                state.members.is_empty()
                            })
                            .unwrap_or(true);
                        if empty {
                            break;
                        }
                    }
                });
            }
            Ok(Self { guard })
        }

        pub(crate) fn try_wait(
            &self,
            child: &mut tokio::process::Child,
        ) -> io::Result<Option<std::process::ExitStatus>> {
            let mut tracked = self
                .guard
                .tracked
                .lock()
                .map_err(|_| io::Error::other("Process tracking lock failed"))?;
            tracked.refresh();
            let status = child.try_wait()?;
            if status.is_some() {
                if let Some(group) = &mut tracked.owned_group {
                    group.unreaped = false;
                }
                tracked.refresh();
            }
            Ok(status)
        }

        pub(crate) async fn wait(
            &self,
            child: &mut tokio::process::Child,
        ) -> io::Result<std::process::ExitStatus> {
            loop {
                if let Some(status) = self.try_wait(child)? {
                    return Ok(status);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        pub(crate) async fn stop(&self, grace: Duration) -> io::Result<()> {
            let guard = self.guard.clone();
            tokio::task::spawn_blocking(move || {
                let _stop = guard
                    .stopping
                    .lock()
                    .map_err(|_| io::Error::other("Process stop lock failed"))?;
                let mut signalled = HashSet::new();
                {
                    let mut state = guard
                        .tracked
                        .lock()
                        .map_err(|_| io::Error::other("Process tracking lock failed"))?;
                    state.freeze();
                    for member in state.members.values() {
                        member.signal(libc::SIGTERM);
                        member.signal(libc::SIGCONT);
                        signalled.insert((member.pid, member.born));
                    }
                }
                let deadline = Instant::now() + grace.min(Duration::from_secs(5));
                loop {
                    {
                        let mut state = guard
                            .tracked
                            .lock()
                            .map_err(|_| io::Error::other("Process tracking lock failed"))?;
                        state.refresh();
                        if state.members.is_empty() {
                            return Ok(());
                        }
                        for member in state.members.values() {
                            if signalled.insert((member.pid, member.born)) {
                                member.signal(libc::SIGTERM);
                                member.signal(libc::SIGCONT);
                            }
                        }
                        if Instant::now() >= deadline {
                            state.force_stop();
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let deadline = Instant::now() + Duration::from_millis(350);
                loop {
                    let mut state = guard
                        .tracked
                        .lock()
                        .map_err(|_| io::Error::other("Process tracking lock failed"))?;
                    state.refresh();
                    if state.members.is_empty() {
                        return Ok(());
                    }
                    if Instant::now() >= deadline {
                        for member in state.members.values() {
                            member.signal(libc::SIGCONT);
                        }
                        return Err(io::Error::other(
                            "Owned processes did not stop within the cleanup deadline",
                        ));
                    }
                    state.force_stop();
                    drop(state);
                    std::thread::sleep(Duration::from_millis(20));
                }
            })
            .await
            .map_err(io::Error::other)?
        }
    }

    fn process_info(pid: i32) -> Option<Identity> {
        inspect_process(pid).filter(|identity| identity.alive)
    }

    fn process_exists(pid: i32) -> bool {
        unsafe {
            let exists = libc::kill(pid, 0) == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            if !exists {
                return false;
            }
            // macOS can stop exposing BSD info before an exited child is
            // reaped. Observe that state without consuming its owner's wait.
            let mut exited: libc::siginfo_t = std::mem::zeroed();
            let observed = libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut exited,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            ) == 0;
            !(observed && exited.si_pid() == pid)
        }
    }

    #[cfg(target_os = "macos")]
    fn inspect_process(pid: i32) -> Option<Identity> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (read == size && info.pbi_pid == pid as u32).then_some(Identity {
            pid,
            parent: info.pbi_ppid as i32,
            born: (info.pbi_start_tvsec, info.pbi_start_tvusec),
            alive: info.pbi_status != libc::SZOMB,
            group: info.pbi_pgid as i32,
        })
    }

    #[cfg(target_os = "macos")]
    fn child_pids(parent: i32) -> Vec<i32> {
        let mut capacity = 32;
        loop {
            let mut pids = vec![0i32; capacity];
            let count = unsafe {
                libc::proc_listchildpids(
                    parent,
                    pids.as_mut_ptr().cast(),
                    (pids.len() * std::mem::size_of::<i32>()) as i32,
                )
            };
            if count <= 0 {
                return Vec::new();
            }
            if count as usize >= pids.len() && capacity < 65536 {
                capacity *= 2;
                continue;
            }
            pids.truncate((count as usize).min(pids.len()));
            return pids;
        }
    }

    #[cfg(target_os = "linux")]
    fn inspect_process(pid: i32) -> Option<Identity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        let state = fields.first()?;
        Some(Identity {
            pid,
            parent: fields.get(1)?.parse().ok()?,
            born: (fields.get(19)?.parse().ok()?, 0),
            alive: *state != "Z" && *state != "X",
            group: fields.get(2)?.parse().ok()?,
        })
    }

    #[cfg(target_os = "linux")]
    fn child_pids(parent: i32) -> Vec<i32> {
        let Ok(tasks) = std::fs::read_dir(format!("/proc/{parent}/task")) else {
            return Vec::new();
        };
        let mut children = HashSet::new();
        for task in tasks.flatten() {
            if let Ok(pids) = std::fs::read_to_string(task.path().join("children")) {
                children.extend(
                    pids.split_whitespace()
                        .filter_map(|pid| pid.parse::<i32>().ok()),
                );
            }
        }
        children.into_iter().collect()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn inspect_process(pid: i32) -> Option<Identity> {
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid as u32)]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        let process = system.process(sysinfo::Pid::from_u32(pid as u32))?;
        Some(Identity {
            pid,
            parent: process.parent()?.as_u32() as i32,
            born: (process.start_time(), 0),
            alive: process.status() != sysinfo::ProcessStatus::Zombie,
            group: unsafe { libc::getpgid(pid) },
        })
    }

    #[cfg(target_os = "macos")]
    fn group_pids(group: i32) -> Vec<i32> {
        let mut capacity = 32;
        loop {
            let mut pids = vec![0i32; capacity];
            let bytes = unsafe {
                // PROC_PGRP_ONLY is defined as 2 in sys/proc_info.h.
                libc::proc_listpids(
                    2,
                    group as u32,
                    pids.as_mut_ptr().cast(),
                    (pids.len() * std::mem::size_of::<i32>()) as i32,
                )
            };
            if bytes <= 0 {
                return Vec::new();
            }
            let count = bytes as usize / std::mem::size_of::<i32>();
            if count >= capacity && capacity < 65536 {
                capacity *= 2;
                continue;
            }
            pids.truncate(count.min(capacity));
            return pids;
        }
    }

    #[cfg(target_os = "linux")]
    fn group_pids(group: i32) -> Vec<i32> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter(|pid| process_info(*pid).is_some_and(|info| info.group == group))
            .collect()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn group_pids(group: i32) -> Vec<i32> {
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system
            .processes()
            .keys()
            .map(|pid| pid.as_u32() as i32)
            .filter(|pid| unsafe { libc::getpgid(*pid) } == group)
            .collect()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn child_pids(parent: i32) -> Vec<i32> {
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        system
            .processes()
            .values()
            .filter(|process| {
                process
                    .parent()
                    .is_some_and(|pid| pid.as_u32() == parent as u32)
            })
            .map(|process| process.pid().as_u32() as i32)
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn dropping_guard_stops_observed_orphans_without_touching_a_sibling() {
            use std::process::Stdio;
            let dir = tempfile::tempdir().unwrap();
            let pids_file = dir.path().join("pids.json");
            let mut sibling = tokio::process::Command::new("python3")
                .args(["-c", "import time; time.sleep(60)"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let sibling_identity = process_info(sibling.id().unwrap() as i32).unwrap();
            let mut command = tokio::process::Command::new("python3");
            command.args(["-c", "import json,pathlib,subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); pathlib.Path(sys.argv[1]).write_text(json.dumps([child.pid])); time.sleep(60)"]).arg(&pids_file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
            let mut child = command.spawn().unwrap();
            let tree = ProcessTree::attach(&child).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while std::fs::read(&pids_file)
                    .ok()
                    .and_then(|value| serde_json::from_slice::<Vec<u32>>(&value).ok())
                    .is_none()
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            let pids: Vec<i32> =
                serde_json::from_slice(&std::fs::read(&pids_file).unwrap()).unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                while !tree
                    .guard
                    .tracked
                    .lock()
                    .unwrap()
                    .members
                    .contains_key(&pids[0])
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            child.kill().await.unwrap();
            drop(tree);
            let gone = tokio::time::timeout(Duration::from_secs(3), async {
                while process_info(pids[0]).is_some() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .is_ok();
            let sibling_alive = sibling_identity.current();
            if !gone {
                if let Some(pid) = process_info(pids[0]) {
                    pid.signal(libc::SIGKILL);
                }
            }
            sibling.kill().await.unwrap();
            assert!(gone, "Observed reparented tool survived guard drop");
            assert!(sibling_alive, "Unrelated sibling was stopped");
        }

        #[tokio::test]
        async fn controlled_stop_captures_a_new_session_started_by_a_termination_handler() {
            use std::process::Stdio;
            let dir = tempfile::tempdir().unwrap();
            let ready = dir.path().join("ready");
            let late_pid = dir.path().join("late.pid");
            let source = r#"
import pathlib, signal, subprocess, sys, time
def on_stop(*_):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], start_new_session=True)
    pathlib.Path(sys.argv[2]).write_text(str(child.pid))
    while True: time.sleep(1)
signal.signal(signal.SIGTERM, on_stop)
pathlib.Path(sys.argv[1]).write_text('ready')
while True: time.sleep(1)
"#;
            let mut child = tokio::process::Command::new("python3")
                .args(["-c", source])
                .arg(&ready)
                .arg(&late_pid)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let tree = ProcessTree::attach(&child).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !ready.exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            tokio::time::timeout(
                Duration::from_secs(4),
                tree.stop(Duration::from_millis(400)),
            )
            .await
            .unwrap()
            .unwrap();
            let pid: i32 = std::fs::read_to_string(late_pid).unwrap().parse().unwrap();
            let survived = process_info(pid).is_some();
            if let Some(identity) = process_info(pid) {
                identity.signal(libc::SIGKILL);
            }
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .unwrap()
                .unwrap();
            assert!(
                !survived,
                "Termination handler's separate-session child survived cleanup"
            );
        }

        #[test]
        fn reused_pid_identity_is_never_owned_or_signalled() {
            let current = process_info(std::process::id() as i32).unwrap();
            let stale = Identity {
                born: (current.born.0.wrapping_sub(1), current.born.1),
                ..current
            };
            assert!(!stale.current());
            let mut tracked = Tracked {
                members: HashMap::from([(stale.pid, stale)]),
                owned_group: None,
            };
            tracked.force_stop();
            assert!(tracked.members.is_empty());
        }

        #[test]
        fn recycled_group_leader_cannot_reestablish_ownership() {
            let current = process_info(std::process::id() as i32).unwrap();
            let stale = Identity {
                born: (current.born.0.wrapping_sub(1), current.born.1),
                ..current
            };
            let mut tracked = Tracked {
                members: HashMap::new(),
                owned_group: Some(OwnedGroup {
                    id: current.pid,
                    leader: Some(stale),
                    unreaped: true,
                }),
            };
            tracked.refresh();
            assert!(tracked.owned_group.is_none() && tracked.members.is_empty());
        }
    }
}

#[cfg(unix)]
pub(crate) use unix::ProcessTree;

#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct ProcessTree(std::sync::Arc<WindowsJob>);
#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl ProcessTree {
    pub(crate) fn attach(child: &tokio::process::Child) -> io::Result<Self> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Process already exited"))?;
        Self::attach_handle(process)
    }

    pub(crate) fn attach_pid(pid: u32) -> io::Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = Self::attach_handle(process);
        unsafe {
            CloseHandle(process);
        }
        result
    }

    fn attach_handle(process: windows_sys::Win32::Foundation::HANDLE) -> io::Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, process) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(std::sync::Arc::new(WindowsJob(job))))
        }
    }

    pub(crate) async fn stop(&self, _grace: Duration) -> io::Result<()> {
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 .0, 1) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn try_wait(
        &self,
        child: &mut tokio::process::Child,
    ) -> io::Result<Option<std::process::ExitStatus>> {
        child.try_wait()
    }

    pub(crate) async fn wait(
        &self,
        child: &mut tokio::process::Child,
    ) -> io::Result<std::process::ExitStatus> {
        child.wait().await
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
