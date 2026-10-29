//! Shutdown admission barrier for structured actors.

use super::live_ownership::{LiveLease, ManagerLeases, OwnerState};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

pub(super) struct Ownership {
    leases: ManagerLeases,
    held: Mutex<HashMap<String, LiveLease>>,
    release_error: Mutex<Option<String>>,
    pub(super) admission: Arc<Admission>,
    pub(super) shutdown: Arc<tokio::sync::RwLock<()>>,
}

impl Ownership {
    pub(super) fn new(root: &Path) -> Result<Self, String> {
        Ok(Self {
            leases: ManagerLeases::new(root)?,
            held: Mutex::new(HashMap::new()),
            release_error: Mutex::new(None),
            admission: Arc::new(Admission::default()),
            shutdown: Arc::new(tokio::sync::RwLock::new(())),
        })
    }

    pub(super) fn ensure(&self, owner: &str) -> Result<(), String> {
        let mut held = self
            .held
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        if let Some(lease) = held.get(owner) {
            return lease.validate();
        }
        if !self.admission.is_open() {
            return Err("Session manager is shutting down".into());
        }
        let lease = self.leases.acquire(owner)?;
        held.insert(owner.to_owned(), lease);
        Ok(())
    }

    pub(super) fn validate(&self, owner: &str) -> Result<(), String> {
        let held = self
            .held
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        held.get(owner)
            .ok_or("Session ownership is unavailable")?
            .validate()
    }

    pub(super) fn epoch(&self, owner: &str) -> Result<Option<uuid::Uuid>, String> {
        let held = self
            .held
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        held.get(owner).map(|lease| lease.epoch()).transpose()
    }

    pub(super) fn status(&self, owner: &str) -> Result<OwnerState, String> {
        let held = self
            .held
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        if let Some(lease) = held.get(owner) {
            lease.validate()?;
            return Ok(OwnerState::Owned);
        }
        self.leases.inspect(owner)
    }

    pub(super) fn release_all(&self) -> Result<(), String> {
        let mut release_error = self
            .release_error
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        if let Some(error) = &*release_error {
            return Err(error.clone());
        }
        let mut held = self
            .held
            .lock()
            .map_err(|_| "Session ownership unavailable")?;
        let mut errors = Vec::new();
        for (_, lease) in held.drain() {
            if let Err(error) = lease.release_clean() {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            let error = errors.join("; ");
            *release_error = Some(error.clone());
            Err(error)
        }
    }
}

#[derive(Default)]
pub(super) struct Admission {
    state: Mutex<State>,
    idle: Notify,
}

#[derive(Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Open,
    Closing,
    Closed,
}

#[derive(Default)]
struct State {
    phase: Phase,
    inflight: usize,
}

pub(super) struct Permit(Arc<Admission>);

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.inflight -= 1;
        if state.inflight == 0 {
            self.0.idle.notify_one();
        }
    }
}

impl Admission {
    pub(super) fn enter(self: &Arc<Self>) -> Result<Permit, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Session admission unavailable")?;
        if state.phase != Phase::Open {
            return Err("Session manager is shutting down".into());
        }
        state.inflight = state
            .inflight
            .checked_add(1)
            .ok_or("Session admission capacity reached")?;
        Ok(Permit(self.clone()))
    }
    pub(super) fn enter_internal(self: &Arc<Self>) -> Result<Permit, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Session admission unavailable")?;
        if state.phase == Phase::Closed {
            return Err("Session manager is closed".into());
        }
        state.inflight = state
            .inflight
            .checked_add(1)
            .ok_or("Session admission capacity reached")?;
        Ok(Permit(self.clone()))
    }
    pub(super) fn is_open(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.phase == Phase::Open)
    }
    pub(super) fn is_closed(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.phase == Phase::Closed)
    }
    #[cfg(test)]
    pub(super) fn inflight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .inflight
    }
    pub(super) fn close(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Session admission unavailable")?;
        if state.phase != Phase::Open {
            return Err("Session manager is already closing".into());
        }
        state.phase = Phase::Closing;
        Ok(())
    }
    pub(super) async fn wait_idle(&self) {
        loop {
            let notified = self.idle.notified();
            if self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .inflight
                == 0
            {
                return;
            }
            notified.await;
        }
    }
    pub(super) fn finish(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Session admission unavailable")?;
        if state.phase != Phase::Closing || state.inflight != 0 {
            return Err("Session admission is not quiescent".into());
        }
        state.phase = Phase::Closed;
        Ok(())
    }
    pub(super) fn reopen(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.phase == Phase::Closing {
            state.phase = Phase::Open;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn shutdown_waits_for_admitted_work_and_rejects_new_admissions() {
        let gate = Arc::new(Admission::default());
        let first = gate.enter().unwrap();
        let second = gate.enter().unwrap();
        gate.close().unwrap();
        assert!(gate.enter().is_err());
        assert!(gate.finish().is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.wait_idle())
                .await
                .is_err()
        );
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.wait_idle())
                .await
                .is_err()
        );
        drop(second);
        tokio::time::timeout(Duration::from_secs(1), gate.wait_idle())
            .await
            .unwrap();
        gate.finish().unwrap();
        gate.reopen();
        assert!(gate.enter().is_err());
    }

    #[tokio::test]
    async fn failed_shutdown_can_reopen_without_losing_inflight_accounting() {
        let gate = Arc::new(Admission::default());
        let first = gate.enter().unwrap();
        gate.close().unwrap();
        gate.reopen();
        let second = gate.enter().unwrap();
        gate.close().unwrap();
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.wait_idle())
                .await
                .is_err()
        );
        drop(second);
        tokio::time::timeout(Duration::from_secs(1), gate.wait_idle())
            .await
            .unwrap();
        gate.finish().unwrap();
    }

    #[tokio::test]
    async fn cleanup_callbacks_remain_counted_during_closing_but_never_after_release() {
        let gate = Arc::new(Admission::default());
        gate.close().unwrap();
        assert!(gate.enter().is_err());
        let callback = gate.enter_internal().unwrap();
        assert!(gate.finish().is_err());
        drop(callback);
        gate.wait_idle().await;
        gate.finish().unwrap();
        assert!(gate.enter_internal().is_err());
    }
}
