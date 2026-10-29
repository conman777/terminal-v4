//! Decodes a profile transport using V4's own model-protocol validators.
use serde_json::Value;

pub(crate) struct Response {
    transport: &'static str,
    head: bool,
    stream: Option<super::streaming::Stream>,
    json: Vec<u8>,
}
impl Response {
    pub(crate) fn new(transport: &'static str) -> Self {
        Self {
            transport,
            head: false,
            stream: None,
            json: Vec::new(),
        }
    }
    pub(crate) fn head(&mut self, streaming: bool) -> Result<(), String> {
        if self.head {
            return Err("Provider returned repeated response headers".into());
        }
        self.head = true;
        if streaming {
            self.stream = Some(super::streaming::Stream::new(self.transport));
        }
        Ok(())
    }
    pub(crate) fn feed(
        &mut self,
        bytes: &[u8],
        on_text: &mut impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.head {
            return Err("Provider returned content before its response headers".into());
        }
        if let Some(stream) = self.stream.as_mut() {
            stream.feed(bytes, on_text)
        } else {
            if bytes.len() > 8_000_000usize.saturating_sub(self.json.len()) {
                return Err("Provider response exceeds 8 MB".into());
            }
            self.json.extend_from_slice(bytes);
            Ok(())
        }
    }
    pub(crate) fn finish(self) -> Result<Value, String> {
        if !self.head {
            return Err("Provider completed without response headers".into());
        }
        let body = match self.stream {
            Some(stream) => stream.finish()?,
            None => {
                serde_json::from_slice(&self.json).map_err(|_| "Provider returned invalid JSON")?
            }
        };
        // Transport EOF and even a streamed finish event are insufficient for
        // tool arguments/roles and incomplete/refused model outputs. Validate
        // against the same protocol path used to append actual V4 history.
        super::protocol::response(self.transport, body.clone(), &mut Vec::new())?;
        Ok(body)
    }
}
