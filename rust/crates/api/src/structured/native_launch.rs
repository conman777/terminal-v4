use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
pub(super) struct NativeLaunchSupervisor {
    state: Mutex<LaunchState>,
    changed: Notify,
}

#[derive(Default)]
struct LaunchState {
    active: usize,
    closing: bool,
}

struct LaunchPermit(Arc<NativeLaunchSupervisor>);

impl Drop for LaunchPermit {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active -= 1;
        self.0.changed.notify_waiters();
    }
}

impl NativeLaunchSupervisor {
    pub(super) fn start<T: Send + 'static>(
        self: &Arc<Self>,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<oneshot::Receiver<T>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Native launch supervisor unavailable")?;
        if state.closing {
            return Err("Native launch supervisor is shutting down".into());
        }
        if state.active >= 4 {
            return Err("Native launch capacity is busy; try again later".into());
        }
        state.active += 1;
        drop(state);
        let permit = LaunchPermit(self.clone());
        let (send, receive) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("v4-native-launch".into())
            .spawn(move || {
                let _permit = permit;
                let result = job();
                let _ = send.send(result);
            });
        if thread.is_err() {
            return Err("Cannot start native launch supervisor".into());
        }
        Ok(receive)
    }

    pub(super) async fn shutdown(&self) {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .closing = true;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .active
                == 0
            {
                return;
            }
            changed.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Mutex},
        time::Duration,
    };

    #[tokio::test]
    async fn saturation_rejects_without_blocking_the_tokio_blocking_pool() {
        let supervisor = Arc::new(NativeLaunchSupervisor::default());
        let (entered, wait_entered) = mpsc::channel();
        let mut releases = Vec::new();
        let mut replies = Vec::new();
        for _ in 0..4 {
            let (release, wait_release) = mpsc::channel();
            let entered = entered.clone();
            replies.push(
                supervisor
                    .start(move || {
                        entered.send(()).unwrap();
                        wait_release.recv().unwrap();
                    })
                    .unwrap(),
            );
            releases.push(release);
        }
        for _ in 0..4 {
            wait_entered.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert!(supervisor.start(|| ()).is_err());
        assert_eq!(tokio::task::spawn_blocking(|| 7).await.unwrap(), 7);
        for release in releases {
            release.send(()).unwrap();
        }
        for reply in replies {
            reply.await.unwrap();
        }
        supervisor.shutdown().await;
        assert!(supervisor.start(|| ()).is_err());
    }

    #[tokio::test]
    async fn shutdown_waits_for_owned_late_launch_after_caller_drops() {
        let supervisor = Arc::new(NativeLaunchSupervisor::default());
        let (entered, wait_entered) = mpsc::channel();
        let (release, wait_release) = mpsc::channel();
        let registered = Arc::new(Mutex::new(false));
        let reply = supervisor
            .start({
                let registered = registered.clone();
                move || {
                    entered.send(()).unwrap();
                    wait_release.recv().unwrap();
                    *registered.lock().unwrap() = true;
                }
            })
            .unwrap();
        wait_entered.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(reply);
        let mut shutdown = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.shutdown().await }
        });
        let second_shutdown = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.shutdown().await }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut shutdown)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        shutdown.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), second_shutdown)
            .await
            .unwrap()
            .unwrap();
        assert!(*registered.lock().unwrap());
    }
}
