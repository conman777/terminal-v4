use super::*;
use std::io::{self, Write};

const REQUEST_BYTES: usize = 24_000_000;
const QUEUED_BYTES: usize = 48_000_000;

// Serialized bytes only: Value allocation overhead and active HTTP buffers have
// separate limits. Field order releases the body before its reservation.
pub(in crate::provider_connections) struct QueuedBody {
    pub(super) body: Value,
    _reservation: Reservation,
}
struct Reservation {
    bytes: usize,
    used: Arc<AtomicUsize>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct Count(usize);
impl Write for Count {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > REQUEST_BYTES.saturating_sub(self.0) {
            return Err(io::ErrorKind::OutOfMemory.into());
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl QueuedBody {
    pub(super) fn new(body: Value, used: Arc<AtomicUsize>) -> Result<Self, ConnectionError> {
        let mut count = Count(0);
        serde_json::to_writer(&mut count, &body).map_err(|error| {
            if error.is_io() {
                ConnectionError::CapacityReached
            } else {
                ConnectionError::InvalidInput
            }
        })?;
        used.try_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current
                .checked_add(count.0)
                .filter(|next| *next <= QUEUED_BYTES)
        })
        .map_err(|_| ConnectionError::CapacityReached)?;
        Ok(Self {
            body,
            _reservation: Reservation {
                bytes: count.0,
                used,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_serialized_limits_include_json_escaping_and_release_on_unstarted_drop() {
        let used = Arc::new(AtomicUsize::new(0));
        let first =
            QueuedBody::new(Value::String("x".repeat(REQUEST_BYTES - 2)), used.clone()).unwrap();
        let second =
            QueuedBody::new(Value::String("x".repeat(REQUEST_BYTES - 2)), used.clone()).unwrap();
        assert_eq!(used.load(Ordering::Acquire), QUEUED_BYTES);
        assert!(matches!(
            QueuedBody::new(json!(null), used.clone()),
            Err(ConnectionError::CapacityReached)
        ));
        drop(first);
        assert_eq!(used.load(Ordering::Acquire), REQUEST_BYTES);
        drop(second);
        assert_eq!(used.load(Ordering::Acquire), 0);
        assert!(matches!(
            QueuedBody::new(Value::String("\n".repeat(REQUEST_BYTES / 2)), used.clone()),
            Err(ConnectionError::CapacityReached)
        ));
        assert_eq!(used.load(Ordering::Acquire), 0);
    }
    #[test]
    fn concurrent_reservations_cannot_exceed_the_aggregate_limit() {
        let used = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(std::sync::Barrier::new(4));
        let workers: Vec<_> = (0..3)
            .map(|_| {
                let used = used.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    let body = Value::String("x".repeat(REQUEST_BYTES - 2));
                    gate.wait();
                    let result = QueuedBody::new(body, used);
                    gate.wait();
                    result
                })
            })
            .collect();
        gate.wait();
        gate.wait();
        assert_eq!(used.load(Ordering::Acquire), QUEUED_BYTES);
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(ConnectionError::CapacityReached)))
                .count(),
            1
        );
        drop(results);
        assert_eq!(used.load(Ordering::Acquire), 0);
    }
}
