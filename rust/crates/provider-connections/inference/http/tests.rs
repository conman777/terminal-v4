use super::*;
use crate::fixtures::effective;
use crate::inference::http_tests::{listener, read_request};
use std::{io::Write, time::Instant};

fn prepared(base: &str, timeout: Duration) -> (Action, Reader) {
    let mut snapshot = effective(ProfileKind::ActualLocal);
    snapshot.base_url = base.into();
    let plan = InferencePlan::prepare(&snapshot, "selected").unwrap();
    let body = plan
        .encode_request(&serde_json::json!({"model":"selected","input":"hi"}))
        .unwrap();
    Action::prepare(
        AdmissionOrigin::test_fresh(),
        &plan,
        ConsumerKind::StructuredTurn,
        body,
        ResolvedAuthorization::None,
        timeout,
    )
    .unwrap()
}
fn finish(owner: &mut Box<dyn OwnedRunningResource>, reader: &Reader) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !reader.ready() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    loop {
        match owner.cancel_and_join() {
            Ok(()) => break,
            Err(LeaseError::ResourceStopPending) => {}
            Err(error) => panic!("{error:?}"),
        };
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn slow_consumers_have_bounded_queue_and_the_whole_exchange_still_times_out() {
    let (server, base) = listener();
    let (action, reader) = prepared(&base, Duration::from_millis(350));
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        read_request(&mut stream);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 4000000\r\n\r\n").unwrap();
        let _ = stream.write_all(&vec![b'x'; 4_000_000]);
    });
    let mut owner = match Box::new(action).start() {
        StartOutcome::Started(owner) => owner,
        _ => panic!("worker unavailable"),
    };
    let deadline = Instant::now() + Duration::from_millis(250);
    let mut saw_buffered = false;
    while !reader.ready() && Instant::now() < deadline {
        let state = reader.0.state.lock().unwrap();
        assert!(state.queued_bytes <= MAX_BUFFER_BYTES);
        assert!(state.queue.len() <= MAX_BUFFER_EVENTS);
        saw_buffered |= state.queued_bytes > 500_000;
        drop(state);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(saw_buffered);
    assert!(!reader.ready());
    finish(&mut owner, &reader);
    worker.join().unwrap();
    assert_eq!(
        reader.outcome().unwrap(),
        Some(Err(InferenceFailure::Timeout))
    );
    let state = reader.0.state.lock().unwrap();
    assert!(state.queue.is_empty());
    assert_eq!(state.queued_bytes, 0);
}

#[test]
fn inert_actions_reject_other_origins_consumers_and_snapshots_before_start() {
    let (action, reader) = prepared("http://127.0.0.1:9/v1", Duration::from_secs(1));
    let snapshot = action.plan.snapshot.clone();
    for consumer in [
        ConsumerKind::Discovery,
        ConsumerKind::StructuredCompact,
        ConsumerKind::Cli,
        ConsumerKind::DurableTask,
        ConsumerKind::StructuredTurn,
    ] {
        assert_eq!(
            action.validate_for_admission(&AdmissionOrigin::test_fresh(), &snapshot, consumer),
            Err(LeaseError::ConfigurationChanged)
        );
    }
    let mut changed = snapshot;
    changed.reference.revision = crate::fixtures::NEXT_REVISION.into();
    assert_eq!(
        action.validate_for_admission(&action.origin, &changed, action.consumer),
        Err(LeaseError::ConfigurationChanged)
    );
    assert_eq!(
        action.validate_for_admission(
            &action.origin,
            &action.plan.snapshot,
            ConsumerKind::Discovery
        ),
        Err(LeaseError::ConfigurationChanged)
    );
    assert_eq!(
        action.validate_for_admission(&action.origin, &action.plan.snapshot, action.consumer),
        Ok(())
    );
    assert!(!reader.ready());
    assert!(!reader.0.joined.load(Ordering::Acquire));
}
