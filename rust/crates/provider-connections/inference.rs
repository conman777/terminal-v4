//! Profile-bound request preparation. Network ownership remains in the supervisor.
use crate::*;
use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::Value;
use std::io::{self, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const MAX_REQUEST_BYTES: usize = 24_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceConsumer {
    Conversation,
    Compaction,
    Cli,
    Task,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceFailure {
    Cancelled,
    ConfigurationChanged,
    Transport,
    Timeout,
    HttpStatus(u16),
    ContentType,
    ResponseTooLarge,
    WorkerUnavailable,
    WorkerPanicked,
}
pub enum InferencePoll {
    Pending,
    Head {
        streaming: bool,
    },
    Chunk(Vec<u8>),
    /// Transport EOF after original join and durable release. The consumer must
    /// still validate JSON/SSE protocol completion before accepting model output.
    Complete,
    Failed(InferenceFailure),
}
pub struct InferenceTicket {
    origin: Arc<()>,
    cancel: Arc<AtomicBool>,
    caller_dropped: Arc<AtomicBool>,
    cancel_io: tokio_util::sync::CancellationToken,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InferenceUsage {
    pub unreleased_requests: usize,
    pub retained_requests: usize,
}
impl Drop for InferenceTicket {
    fn drop(&mut self) {
        self.caller_dropped.store(true, Ordering::Release);
        self.request_cancel();
    }
}
impl InferenceTicket {
    /// Cancellation is a signal only; the supervisor retains the original owner
    /// until its join, durable release and last-caller retirement all succeed.
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        self.cancel_io.cancel();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InferencePlan {
    pub(crate) snapshot: EffectiveConnection,
    model: String,
    url: String,
}
impl InferencePlan {
    pub fn prepare(snapshot: &EffectiveConnection, model: &str) -> Result<Self> {
        discovery::normalize::validate_id(model).map_err(|_| Error::InvalidInput)?;
        let stored = profile_from_snapshot(snapshot);
        runtime::resolve(&stored.scope, &stored, &snapshot.reference, None)?;
        let suffix = match snapshot.transport {
            Transport::OpenAiResponses => "responses",
            Transport::OpenAiChat => "chat/completions",
        };
        Ok(Self {
            snapshot: snapshot.clone(),
            model: model.into(),
            url: format!("{}/{suffix}", snapshot.base_url),
        })
    }
    pub fn transport(&self) -> Transport {
        self.snapshot.transport
    }
    pub fn model(&self) -> &str {
        &self.model
    }
    pub fn request_url(&self) -> &str {
        &self.url
    }
    pub fn encode_request(&self, body: &Value) -> Result<Vec<u8>> {
        let object = body.as_object().ok_or(Error::InvalidInput)?;
        if object.get("model").and_then(Value::as_str) != Some(self.model())
            || ["headers", "api_key", "base_url", "url", "extra_headers"]
                .iter()
                .any(|key| object.contains_key(*key))
        {
            return Err(Error::InvalidInput);
        }
        let mut output = RequestBytes {
            bytes: vec![],
            exceeded: false,
        };
        let encoded = serde_json::to_writer(&mut output, &StreamingRequest(body));
        if output.exceeded {
            return Err(Error::CapacityReached);
        }
        encoded.map_err(|_| Error::InvalidInput)?;
        Ok(output.bytes)
    }
}

struct StreamingRequest<'a>(&'a Value);
impl Serialize for StreamingRequest<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let object = self.0.as_object().expect("validated object");
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in object {
            if key != "stream" {
                map.serialize_entry(key, value)?;
            }
        }
        map.serialize_entry("stream", &true)?;
        map.end()
    }
}
struct RequestBytes {
    bytes: Vec<u8>,
    exceeded: bool,
}
impl Write for RequestBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_REQUEST_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("request capacity"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) mod http;
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod retirement_tests;
pub(crate) mod supervisor;
#[cfg(test)]
mod tests;
