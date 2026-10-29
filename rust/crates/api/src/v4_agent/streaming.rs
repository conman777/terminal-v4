use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_FRAME: usize = 1_048_576;
const MAX_STREAM: usize = 16_000_000;
const MAX_EVENTS: usize = 100_000;

#[derive(Default)]
struct Framing {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    skip_lf: bool,
    first_line: bool,
    events: usize,
}
impl Framing {
    fn feed(
        &mut self,
        bytes: &[u8],
        event: &mut impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\n' || byte == b'\r' {
                self.consume_line(event)?;
                self.skip_lf = byte == b'\r';
            } else {
                if self.line.len() + self.data.len() >= MAX_FRAME {
                    return Err("Provider stream event exceeds 1 MB".into());
                }
                self.line.push(byte);
            }
        }
        Ok(())
    }
    fn consume_line(
        &mut self,
        event: &mut impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let line = std::mem::take(&mut self.line);
        let line = if !self.first_line {
            self.first_line = true;
            line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&line)
        } else {
            &line
        };
        if line.is_empty() {
            if self.has_data {
                self.events += 1;
                if self.events > MAX_EVENTS {
                    return Err("Provider exceeded the stream event limit".into());
                }
                if self.data.last() == Some(&b'\n') {
                    self.data.pop();
                }
                event(&self.data)?;
                self.data.clear();
                self.has_data = false;
            }
        } else if let Some(data) = line.strip_prefix(b"data:") {
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if self.data.len() + data.len() + 1 > MAX_FRAME {
                return Err("Provider stream event exceeds 1 MB".into());
            }
            self.has_data = true;
            self.data.extend_from_slice(data);
            self.data.push(b'\n');
        } else if line == b"data" {
            self.has_data = true;
            self.data.push(b'\n');
        }
        Ok(())
    }
}

#[derive(Default)]
struct ToolDelta {
    id: String,
    name: String,
    arguments: String,
}
#[derive(Default)]
struct Chat {
    text: String,
    reasoning: String,
    refusal: String,
    tools: BTreeMap<usize, ToolDelta>,
    finish: Option<String>,
    usage: Value,
    complete: bool,
}
impl Chat {
    fn event(
        &mut self,
        value: Value,
        text: &mut impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.complete {
            return Err("Provider sent output after stream completion".into());
        }
        if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
            self.usage = usage.clone();
        }
        let Some(choice) = value["choices"].as_array().and_then(|c| c.first()) else {
            return Ok(());
        };
        if choice["index"].as_u64().is_some_and(|i| i != 0) {
            return Err("Multiple response choices are not supported".into());
        }
        let delta = &choice["delta"];
        if delta["role"]
            .as_str()
            .is_some_and(|role| role != "assistant")
        {
            return Err("Provider stream returned an invalid role".into());
        }
        if let Some(part) = delta["content"].as_str() {
            self.text.push_str(part);
            text(part)?;
        }
        if let Some(part) = delta["reasoning_content"].as_str() {
            self.reasoning.push_str(part);
        }
        if let Some(part) = delta["refusal"].as_str() {
            self.refusal.push_str(part);
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = call["index"]
                .as_u64()
                .filter(|i| *i < 16)
                .ok_or("Invalid streamed tool index")? as usize;
            let tool = self.tools.entry(index).or_default();
            if let Some(id) = call["id"].as_str() {
                if !tool.id.is_empty() && tool.id != id {
                    return Err("Provider changed a streamed tool ID".into());
                }
                tool.id = id.to_owned();
            }
            if call["type"].as_str().is_some_and(|kind| kind != "function") {
                return Err("Unsupported streamed tool type".into());
            }
            if let Some(part) = call["function"]["name"].as_str() {
                tool.name.push_str(part);
            }
            if let Some(part) = call["function"]["arguments"].as_str() {
                tool.arguments.push_str(part);
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            if self.finish.as_deref().is_some_and(|old| old != reason) {
                return Err("Provider changed the stream stop reason".into());
            }
            self.finish = Some(reason.to_owned());
        }
        Ok(())
    }
    fn finish(self) -> Result<Value, String> {
        if !self.complete || self.finish.is_none() {
            return Err("Provider stream ended before completion".into());
        }
        let mut message = json!({"role":"assistant","content":if self.text.is_empty(){Value::Null}else{json!(self.text)}});
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = json!(self.reasoning);
        }
        if !self.refusal.is_empty() {
            message["refusal"] = json!(self.refusal);
        }
        if !self.tools.is_empty() {
            if self.tools.keys().copied().ne(0..self.tools.len()) {
                return Err("Provider stream omitted a tool call".into());
            }
            message["tool_calls"]=json!(self.tools.into_values().map(|tool|json!({"id":tool.id,"type":"function","function":{"name":tool.name,"arguments":tool.arguments}})).collect::<Vec<_>>());
        }
        Ok(
            json!({"choices":[{"index":0,"message":message,"finish_reason":self.finish}],"usage":self.usage}),
        )
    }
}
struct Block {
    value: Value,
    input_json: String,
    closed: bool,
}
#[derive(Default)]
struct Anthropic {
    body: Option<Value>,
    blocks: BTreeMap<usize, Block>,
    complete: bool,
}
impl Anthropic {
    fn event(
        &mut self,
        mut value: Value,
        text: &mut impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.complete && value["type"] != "ping" {
            return Err("Provider sent output after stream completion".into());
        }
        match value["type"].as_str() {
            Some("message_start") => {
                if self.body.is_some() {
                    return Err("Provider repeated the message start".into());
                }
                let message = value["message"].take();
                if message["role"] != "assistant"
                    || !message["content"].as_array().is_some_and(|v| v.is_empty())
                {
                    return Err("Provider returned an invalid streamed message header".into());
                }
                self.body = Some(message);
            }
            Some("content_block_start") => {
                if self.body.is_none() {
                    return Err("Provider stream has no message start".into());
                }
                let index = value["index"]
                    .as_u64()
                    .filter(|i| *i < 64)
                    .ok_or("Invalid streamed content index")? as usize;
                if self.blocks.contains_key(&index) {
                    return Err("Provider repeated a content block".into());
                }
                let block = value["content_block"].take();
                if !block.is_object() {
                    return Err("Invalid streamed content block".into());
                }
                if block["type"] == "text" {
                    if let Some(initial) = block["text"].as_str() {
                        text(initial)?;
                    }
                }
                self.blocks.insert(
                    index,
                    Block {
                        value: block,
                        input_json: String::new(),
                        closed: false,
                    },
                );
            }
            Some("content_block_delta" | "content_block_stop") => {
                let index = value["index"]
                    .as_u64()
                    .ok_or("Invalid streamed content index")? as usize;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|b| !b.closed)
                    .ok_or("Provider updated an unopened or closed content block")?;
                if value["type"] == "content_block_stop" {
                    if !block.input_json.is_empty() {
                        let input: Value = serde_json::from_str(&block.input_json)
                            .map_err(|_| "Provider streamed invalid tool JSON")?;
                        if !input.is_object() {
                            return Err("Provider streamed invalid tool input".into());
                        }
                        block.value["input"] = input;
                    }
                    block.closed = true;
                } else {
                    let delta = &value["delta"];
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            let part = delta["text"].as_str().ok_or("Invalid streamed text")?;
                            append(&mut block.value, "text", part)?;
                            text(part)?;
                        }
                        Some("input_json_delta") => block.input_json.push_str(
                            delta["partial_json"]
                                .as_str()
                                .ok_or("Invalid streamed tool JSON")?,
                        ),
                        Some("thinking_delta") => append(
                            &mut block.value,
                            "thinking",
                            delta["thinking"]
                                .as_str()
                                .ok_or("Invalid streamed thinking")?,
                        )?,
                        Some("signature_delta") => append(
                            &mut block.value,
                            "signature",
                            delta["signature"]
                                .as_str()
                                .ok_or("Invalid streamed signature")?,
                        )?,
                        Some("citations_delta") => {
                            let object = block
                                .value
                                .as_object_mut()
                                .ok_or("Invalid streamed block")?;
                            let citations = object
                                .entry("citations")
                                .or_insert_with(|| json!([]))
                                .as_array_mut()
                                .ok_or("Invalid streamed citations")?;
                            citations.push(delta["citation"].clone());
                        }
                        _ => {}
                    }
                }
            }
            Some("message_delta") => {
                let body = self
                    .body
                    .as_mut()
                    .ok_or("Provider stream has no message start")?;
                if let Some(delta) = value["delta"].as_object() {
                    for (key, value) in delta {
                        body[key] = value.clone();
                    }
                }
                if let Some(usage) = value["usage"].as_object() {
                    if !body["usage"].is_object() {
                        body["usage"] = json!({});
                    }
                    for (key, value) in usage {
                        body["usage"][key] = value.clone();
                    }
                }
            }
            Some("message_stop") => {
                if self.body.is_none() || self.blocks.values().any(|b| !b.closed) {
                    return Err("Provider stopped with unfinished content".into());
                }
                self.complete = true;
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(mut self) -> Result<Value, String> {
        if !self.complete {
            return Err("Provider stream ended before completion".into());
        }
        if self.blocks.keys().copied().ne(0..self.blocks.len()) {
            return Err("Provider stream omitted a content block".into());
        }
        let mut body = self.body.take().ok_or("Provider stream has no message")?;
        body["content"] = json!(self
            .blocks
            .into_values()
            .map(|b| b.value)
            .collect::<Vec<_>>());
        Ok(body)
    }
}
fn append(value: &mut Value, name: &str, part: &str) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or("Invalid streamed content block")?;
    let field = object.entry(name).or_insert_with(|| json!(""));
    if let Value::String(current) = field {
        current.push_str(part);
        Ok(())
    } else {
        Err("Invalid streamed content field".into())
    }
}
enum Decode {
    Chat(Chat),
    Anthropic(Anthropic),
    Responses(Option<Value>),
}
impl Decode {
    fn event(
        &mut self,
        data: &[u8],
        text: &mut impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        if data == b"[DONE]" {
            return match self {
                Self::Chat(chat) if chat.finish.is_some() => {
                    chat.complete = true;
                    Ok(())
                }
                Self::Responses(Some(_)) => Ok(()),
                _ => Err("Provider stream stopped before completion".into()),
            };
        }
        let mut value: Value =
            serde_json::from_slice(data).map_err(|_| "Provider streamed invalid JSON")?;
        if value["type"] == "error"
            || value.get("error").is_some_and(|v| !v.is_null())
            || matches!(
                value["type"].as_str(),
                Some("response.failed" | "response.incomplete")
            )
        {
            return Err("Provider streaming error; review the model and account settings".into());
        }
        match self {
            Self::Chat(chat) => chat.event(value, text),
            Self::Anthropic(anthropic) => anthropic.event(value, text),
            Self::Responses(completed) => {
                if completed.is_some() {
                    return Err("Provider sent output after stream completion".into());
                }
                match value["type"].as_str() {
                    Some("response.output_text.delta") => {
                        text(value["delta"].as_str().ok_or("Invalid streamed text")?)?
                    }
                    Some("response.completed") => {
                        let body = value["response"].take();
                        if body["status"] != "completed" || !body["output"].is_array() {
                            return Err("Provider stream completed with an invalid response".into());
                        }
                        *completed = Some(body);
                    }
                    _ => {}
                }
                Ok(())
            }
        }
    }
    fn finish(self) -> Result<Value, String> {
        match self {
            Self::Chat(chat) => chat.finish(),
            Self::Anthropic(anthropic) => anthropic.finish(),
            Self::Responses(value) => {
                value.ok_or_else(|| "Provider stream ended before completion".into())
            }
        }
    }
}
pub(super) struct Stream {
    framing: Framing,
    decode: Decode,
    bytes: usize,
}
impl Stream {
    pub(super) fn new(transport: &str) -> Self {
        Self {
            framing: Framing::default(),
            decode: match transport {
                "anthropic-messages" => Decode::Anthropic(Anthropic::default()),
                "openai-responses" => Decode::Responses(None),
                _ => Decode::Chat(Chat::default()),
            },
            bytes: 0,
        }
    }
    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        text: &mut impl FnMut(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or("Provider stream is too large")?;
        if self.bytes > MAX_STREAM {
            return Err("Provider stream exceeds 16 MB".into());
        }
        let decode = &mut self.decode;
        self.framing
            .feed(bytes, &mut |event| decode.event(event, text))
    }
    pub(super) fn finish(self) -> Result<Value, String> {
        if self.framing.has_data || !self.framing.line.is_empty() {
            return Err("Provider stream ended in an unfinished event".into());
        }
        let body = self.decode.finish()?;
        if serde_json::to_vec(&body)
            .map_err(|_| "Could not encode streamed response")?
            .len()
            > 8_000_000
        {
            return Err("Provider response exceeds 8 MB".into());
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(value: Value) -> String {
        format!("data: {value}\r\n\r\n")
    }
    fn feed(stream: &mut Stream, bytes: &[u8], output: &mut String) -> Result<(), String> {
        for chunk in bytes.chunks(1) {
            stream.feed(chunk, &mut |text| {
                output.push_str(text);
                Ok(())
            })?;
        }
        Ok(())
    }
    #[test]
    fn chat_text_is_delivered_before_completion_and_survives_fragmented_unicode() {
        let mut stream = Stream::new("openai-chat");
        let mut output = String::new();
        feed(&mut stream,event(json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"Olá 🌍"},"finish_reason":null}]})).as_bytes(),&mut output).unwrap();
        assert_eq!(output, "Olá 🌍");
        feed(
            &mut stream,
            event(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})).as_bytes(),
            &mut output,
        )
        .unwrap();
        feed(&mut stream, b"data: [DONE]\r\n\r\n", &mut output).unwrap();
        let body = stream.finish().unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], "Olá 🌍");
    }
    #[test]
    fn chat_parallel_tool_arguments_and_provider_reasoning_are_assembled_by_index() {
        let mut stream = Stream::new("openai-chat");
        let mut output = String::new();
        for value in [
            json!({"choices":[{"delta":{"reasoning_content":"hidden state","tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}},{"index":0,"id":"a","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"b\"}"}}]},"finish_reason":"tool_calls"}]}),
        ] {
            feed(&mut stream, event(value).as_bytes(), &mut output).unwrap();
        }
        feed(&mut stream, b"data: [DONE]\n\n", &mut output).unwrap();
        let body = stream.finish().unwrap();
        let mut history = Vec::new();
        let (_, calls) =
            super::super::protocol::response("openai-chat", body, &mut history).unwrap();
        assert_eq!(
            calls,
            vec![
                json!({"id":"a","name":"read_file","input":{"path":"a"}}),
                json!({"id":"b","name":"read_file","input":{"path":"b"}})
            ]
        );
        assert_eq!(history[0]["reasoning_content"], "hidden state");
        assert!(output.is_empty());
    }
    #[test]
    fn anthropic_stream_retains_thinking_signature_tool_json_and_cumulative_usage() {
        let mut stream = Stream::new("anthropic-messages");
        let mut output = String::new();
        for value in [
            json!({"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input_tokens":12}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private thought"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque signature"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t","name":"read_file","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"file\"}"}}),
            json!({"type":"content_block_stop","index":2}),
            json!({"type":"ping"}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}),
            json!({"type":"message_stop"}),
        ] {
            feed(&mut stream, event(value).as_bytes(), &mut output).unwrap();
        }
        assert_eq!(output, "Checking");
        let body = stream.finish().unwrap();
        assert_eq!(body["content"][0]["signature"], "opaque signature");
        assert_eq!(body["content"][2]["input"], json!({"path":"file"}));
        assert_eq!(body["usage"], json!({"input_tokens":12,"output_tokens":15}));
    }
    #[test]
    fn responses_emit_text_then_preserve_the_authoritative_completed_output() {
        let mut stream = Stream::new("openai-responses");
        let mut output = String::new();
        feed(
            &mut stream,
            event(json!({"type":"response.output_text.delta","delta":"Hello"})).as_bytes(),
            &mut output,
        )
        .unwrap();
        assert_eq!(output, "Hello");
        let completed = json!({"status":"completed","output":[{"type":"reasoning","encrypted_content":"opaque"},{"type":"message","content":[{"type":"output_text","text":"Hello"}]}]});
        feed(
            &mut stream,
            event(json!({"type":"response.completed","response":completed})).as_bytes(),
            &mut output,
        )
        .unwrap();
        assert_eq!(stream.finish().unwrap(), completed);
    }
    #[test]
    fn premature_eof_and_error_events_never_become_successful_answers() {
        for transport in ["openai-chat", "openai-responses", "anthropic-messages"] {
            let mut stream = Stream::new(transport);
            let mut output = String::new();
            assert!(feed(
                &mut stream,
                event(json!({"type":"error","error":{"message":"private-secret"}})).as_bytes(),
                &mut output
            )
            .unwrap_err()
            .contains("Provider"));
            assert!(!output.contains("private-secret"));
            let stream = Stream::new(transport);
            assert!(stream.finish().is_err());
        }
    }
    #[test]
    fn multiline_data_comments_cr_only_and_unknown_events_are_supported() {
        let mut stream = Stream::new("openai-responses");
        let mut output = String::new();
        feed(
            &mut stream,
            b": keepalive\revent: future_event\rdata: {\"type\":\"unknown.future\"}\r\r",
            &mut output,
        )
        .unwrap();
        feed(&mut stream,b"data: {\"type\":\"response.completed\",\ndata: \"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",&mut output).unwrap();
        assert_eq!(stream.finish().unwrap()["status"], "completed");
    }
    #[test]
    fn oversized_frames_invalid_json_and_callbacks_are_errors() {
        let mut stream = Stream::new("openai-chat");
        let mut output = String::new();
        assert!(feed(&mut stream, b"data: not-json\n\n", &mut output).is_err());
        let mut stream = Stream::new("openai-chat");
        let huge = vec![b'x'; 1_048_577];
        assert!(stream.feed(&huge, &mut |_| Ok(())).is_err());
        let mut stream = Stream::new("openai-chat");
        assert!(stream
            .feed(
                event(json!({"choices":[{"delta":{"content":"text"}}]})).as_bytes(),
                &mut |_| Err("closed output".into())
            )
            .is_err());
    }
}
