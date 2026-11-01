use serde_json::{json, Map, Value};

const UNSUPPORTED: &str = "Bedrock Converse cannot represent this message content";

fn text_of(content: &Value) -> Result<String, String> {
    match content {
        Value::Null => Ok(String::new()),
        Value::String(text) => Ok(text.clone()),
        Value::Array(parts) => parts
            .iter()
            .map(
                |part| match (part["type"].as_str(), part["text"].as_str()) {
                    (Some("text" | "input_text"), Some(text)) => Ok(text.to_owned()),
                    _ => Err(UNSUPPORTED.to_string()),
                },
            )
            .collect::<Result<Vec<_>, _>>()
            .map(|texts| texts.join("\n")),
        _ => Err(UNSUPPORTED.into()),
    }
}

fn image_block(url: &str) -> Result<Value, String> {
    let (header, data) = url
        .strip_prefix("data:image/")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or(UNSUPPORTED)?;
    let format = match header {
        "png" => "png",
        "jpeg" | "jpg" => "jpeg",
        "gif" => "gif",
        "webp" => "webp",
        _ => return Err(UNSUPPORTED.into()),
    };
    Ok(json!({"image":{"format":format,"source":{"bytes":data}}}))
}

fn user_blocks(content: &Value) -> Result<Vec<Value>, String> {
    let Value::Array(parts) = content else {
        let text = text_of(content)?;
        return Ok(if text.is_empty() {
            vec![]
        } else {
            vec![json!({"text":text})]
        });
    };
    let mut blocks = Vec::new();
    for part in parts {
        match part["type"].as_str() {
            Some("text" | "input_text") => {
                let text = part["text"].as_str().ok_or(UNSUPPORTED)?;
                if !text.is_empty() {
                    blocks.push(json!({"text":text}));
                }
            }
            Some("image_url") => blocks.push(image_block(
                part["image_url"]["url"].as_str().ok_or(UNSUPPORTED)?,
            )?),
            _ => return Err(UNSUPPORTED.into()),
        }
    }
    Ok(blocks)
}

fn push(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut().filter(|last| last["role"] == role) {
        last["content"].as_array_mut().unwrap().extend(blocks);
    } else {
        messages.push(json!({"role":role,"content":blocks}));
    }
}

fn flatten_tools(messages: &mut [Value]) {
    for message in messages {
        for block in message["content"].as_array_mut().into_iter().flatten() {
            if let Some(call) = block.get("toolUse") {
                *block = json!({"text":format!("[tool call {}: {}]", call["name"].as_str().unwrap_or(""), call["input"])});
            } else if let Some(result) = block.get("toolResult") {
                let text = result["content"][0]["text"].as_str().unwrap_or("");
                *block = json!({"text":format!("[tool result: {text}]")});
            }
        }
    }
}

pub(crate) fn request(body: &Value) -> Result<Value, String> {
    let mut system = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for message in body["messages"].as_array().ok_or("Missing messages")? {
        match message["role"].as_str() {
            Some("system" | "developer") => {
                let text = text_of(&message["content"])?;
                if !text.is_empty() {
                    system.push(json!({"text":text}));
                }
            }
            Some("user") => push(&mut messages, "user", user_blocks(&message["content"])?),
            Some("assistant") => {
                let mut blocks = user_blocks(&message["content"])?;
                for call in message["tool_calls"].as_array().into_iter().flatten() {
                    let input: Value = serde_json::from_str(
                        call["function"]["arguments"].as_str().unwrap_or("{}"),
                    )
                    .map_err(|_| "Tool call arguments are not valid JSON")?;
                    if !input.is_object() {
                        return Err("Tool call arguments must be a JSON object".into());
                    }
                    blocks.push(json!({"toolUse":{
                        "toolUseId":call["id"].as_str().ok_or("Tool call is missing an id")?,
                        "name":call["function"]["name"].as_str().ok_or("Tool call is missing a name")?,
                        "input":input
                    }}));
                }
                push(&mut messages, "assistant", blocks);
            }
            Some("tool") => {
                let text = text_of(&message["content"])?;
                push(
                    &mut messages,
                    "user",
                    vec![json!({"toolResult":{
                        "toolUseId":message["tool_call_id"].as_str().ok_or("Tool result is missing an id")?,
                        "content":[{"text":if text.is_empty(){"(no output)".to_owned()}else{text}}]
                    }})],
                );
            }
            _ => return Err(UNSUPPORTED.into()),
        }
    }
    let tools: Vec<Value> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| {
            let function = &tool["function"];
            let mut spec = Map::new();
            spec.insert("name".into(), function["name"].clone());
            if let Some(description) = function["description"].as_str().filter(|d| !d.is_empty()) {
                spec.insert("description".into(), json!(description));
            }
            spec.insert(
                "inputSchema".into(),
                json!({"json":function["parameters"].clone()}),
            );
            json!({"toolSpec":spec})
        })
        .collect();
    if tools.is_empty() {
        flatten_tools(&mut messages);
    }
    let mut out = json!({"messages":messages});
    if !system.is_empty() {
        out["system"] = json!(system);
    }
    if !tools.is_empty() {
        out["toolConfig"] = json!({"tools":tools});
    }
    if let Some(max) = body["max_tokens"]
        .as_u64()
        .or_else(|| body["max_completion_tokens"].as_u64())
    {
        out["inferenceConfig"] = json!({"maxTokens":max});
    }
    Ok(out)
}

pub(crate) fn response(body: &Value) -> Result<Value, String> {
    let message = &body["output"]["message"];
    if message["role"] != "assistant" {
        return Err("Provider returned an invalid assistant message".into());
    }
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    for block in message["content"]
        .as_array()
        .ok_or("Provider returned invalid content")?
    {
        if let Some(part) = block["text"].as_str() {
            text.push_str(part);
        } else if let Some(call) = block.get("toolUse") {
            if !call["input"].is_object() {
                return Err("Provider returned invalid tool arguments".into());
            }
            calls.push(json!({
                "id":call["toolUseId"],
                "type":"function",
                "function":{"name":call["name"],"arguments":call["input"].to_string()}
            }));
        } else if let Some(part) = block["reasoningContent"]["reasoningText"]["text"].as_str() {
            reasoning.push_str(part);
        }
    }
    let finish = match body["stopReason"].as_str() {
        Some("tool_use") => "tool_calls",
        Some("end_turn" | "stop_sequence") => "stop",
        Some("max_tokens") => "length",
        Some("guardrail_intervened" | "content_filtered") => "content_filter",
        _ => return Err("Provider returned an unknown stop reason".into()),
    };
    let mut out =
        json!({"role":"assistant","content":if text.is_empty(){Value::Null}else{json!(text)}});
    if !reasoning.is_empty() {
        out["reasoning_content"] = json!(reasoning);
    }
    if !calls.is_empty() {
        out["tool_calls"] = json!(calls);
    }
    let usage = &body["usage"];
    Ok(json!({
        "choices":[{"index":0,"message":out,"finish_reason":finish}],
        "usage":{
            "prompt_tokens":usage["inputTokens"],
            "completion_tokens":usage["outputTokens"],
            "total_tokens":usage["totalTokens"]
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_body() -> Value {
        json!({
            "model":"m","stream":true,"max_tokens":512,
            "messages":[
                {"role":"system","content":"be brief"},
                {"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}}]},
                {"role":"assistant","content":null,"tool_calls":[
                    {"id":"c1","type":"function","function":{"name":"a","arguments":"{\"x\":1}"}},
                    {"id":"c2","type":"function","function":{"name":"b","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"c1","content":"one"},
                {"role":"tool","tool_call_id":"c2","content":""}
            ],
            "tools":[{"type":"function","function":{"name":"a","description":"does a","parameters":{"type":"object"}}}]
        })
    }

    #[test]
    fn request_maps_roles_tools_images_and_merges_tool_results_into_one_user_turn() {
        assert_eq!(
            request(&chat_body()).unwrap(),
            json!({
                "system":[{"text":"be brief"}],
                "messages":[
                    {"role":"user","content":[{"text":"hi"},{"image":{"format":"png","source":{"bytes":"AQID"}}}]},
                    {"role":"assistant","content":[
                        {"toolUse":{"toolUseId":"c1","name":"a","input":{"x":1}}},
                        {"toolUse":{"toolUseId":"c2","name":"b","input":{}}}]},
                    {"role":"user","content":[
                        {"toolResult":{"toolUseId":"c1","content":[{"text":"one"}]}},
                        {"toolResult":{"toolUseId":"c2","content":[{"text":"(no output)"}]}}]}
                ],
                "toolConfig":{"tools":[{"toolSpec":{"name":"a","description":"does a","inputSchema":{"json":{"type":"object"}}}}]},
                "inferenceConfig":{"maxTokens":512}
            })
        );
    }

    #[test]
    fn request_without_tools_flattens_tool_history_to_text() {
        let mut body = chat_body();
        body.as_object_mut().unwrap().remove("tools");
        let out = request(&body).unwrap();
        assert!(out.get("toolConfig").is_none());
        assert!(!out.to_string().contains("toolUse"));
        assert!(out.to_string().contains("[tool call a: {\\\"x\\\":1}]"));
    }

    #[test]
    fn request_rejects_unsupported_parts_and_bad_tool_arguments() {
        for message in [
            json!({"role":"user","content":[{"type":"input_audio"}]}),
            json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"https://x/y.png"}}]}),
            json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/bmp;base64,AA"}}]}),
            json!({"role":"assistant","tool_calls":[{"id":"c","function":{"name":"a","arguments":"[1]"}}]}),
            json!({"role":"assistant","tool_calls":[{"id":"c","function":{"name":"a","arguments":"nope"}}]}),
            json!({"role":"function","content":"x"}),
        ] {
            assert!(request(&json!({"messages":[message]})).is_err());
        }
    }

    #[test]
    fn response_maps_text_tool_use_reasoning_usage_and_stop_reasons() {
        let converse = json!({
            "output":{"message":{"role":"assistant","content":[
                {"reasoningContent":{"reasoningText":{"text":"think"}}},
                {"text":"Hello"},
                {"toolUse":{"toolUseId":"t1","name":"a","input":{"p":"q"}}}]}},
            "stopReason":"tool_use",
            "usage":{"inputTokens":3,"outputTokens":4,"totalTokens":7}
        });
        assert_eq!(
            response(&converse).unwrap(),
            json!({
                "choices":[{"index":0,"finish_reason":"tool_calls","message":{
                    "role":"assistant","content":"Hello","reasoning_content":"think",
                    "tool_calls":[{"id":"t1","type":"function","function":{"name":"a","arguments":"{\"p\":\"q\"}"}}]}}],
                "usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}
            })
        );
        for (reason, expected) in [
            ("end_turn", "stop"),
            ("max_tokens", "length"),
            ("guardrail_intervened", "content_filter"),
        ] {
            let mut body = converse.clone();
            body["stopReason"] = json!(reason);
            assert_eq!(
                response(&body).unwrap()["choices"][0]["finish_reason"],
                expected
            );
        }
        let mut unknown = converse.clone();
        unknown["stopReason"] = json!("weird");
        assert!(response(&unknown).is_err());
        assert!(response(&json!({"output":{}})).is_err());
    }
}
