use serde_json::{json, Value};

#[cfg(test)]
mod provider_option_tests {
    use super::*;

    #[test]
    fn anthropic_effort_enables_the_documented_thinking_mode_without_changing_history() {
        let history = vec![json!({"role":"user","content":"inspect"})];
        let adaptive = request(
            "anthropic-api",
            "anthropic-messages",
            "claude-opus-4-6",
            "system",
            &history,
            &[],
            Some("max"),
        );
        assert_eq!(adaptive["output_config"], json!({"effort":"max"}));
        assert_eq!(adaptive["thinking"], json!({"type":"adaptive"}));
        let extended = request(
            "anthropic-api",
            "anthropic-messages",
            "claude-opus-4-5-20251101",
            "system",
            &history,
            &[],
            Some("high"),
        );
        assert_eq!(
            extended["thinking"],
            json!({"type":"enabled","budget_tokens":4096})
        );
        let normal = request(
            "anthropic-api",
            "anthropic-messages",
            "claude-sonnet-4-6",
            "system",
            &history,
            &[],
            None,
        );
        assert!(normal.get("thinking").is_none());
        assert!(normal.get("output_config").is_none());
        assert_eq!(adaptive["messages"], json!(history));
    }

    #[test]
    fn chat_effort_uses_its_actual_field_and_nonreasoning_requests_omit_it() {
        let body = request(
            "upstage",
            "openai-chat",
            "solar-pro2",
            "system",
            &[],
            &[],
            Some("medium"),
        );
        assert_eq!(body["reasoning_effort"], "medium");
        assert!(body.get("reasoning").is_none());
        let normal = request(
            "openai-api",
            "openai-responses",
            "gpt-4.1",
            "system",
            &[],
            &[],
            None,
        );
        assert!(normal.get("reasoning").is_none());
    }

    #[test]
    fn known_text_only_models_receive_an_explicit_placeholder_while_saved_images_remain_intact() {
        let history = vec![
            json!({"role":"user","content":[{"type":"text","text":"image"},{"type":"image","mimeType":"image/png","data":"AQID"}]}),
        ];
        let before = history.clone();
        let body = request(
            "deepseek",
            "openai-chat",
            "deepseek-v4-pro",
            "system",
            &history,
            &[],
            None,
        );
        assert_eq!(body["messages"][1]["content"][1]["type"], "text");
        assert!(body["messages"][1]["content"][1]["text"]
            .as_str()
            .unwrap()
            .contains("not supplied"));
        assert!(!body.to_string().contains("AQID"));
        assert_eq!(history, before);
    }

    #[test]
    fn host_evidence_metadata_never_reaches_the_provider_and_saved_tags_remain_intact() {
        let history = vec![
            json!({"role":"user","content":"V4 interrupted action evidence: fixture","_v4HostEvidence":{"version":1,"kind":"interruptedAction","turnId":"fixture","contentHash":"fixture"}}),
        ];
        let before = history.clone();
        for (transport, field) in [
            ("openai-chat", "messages"),
            ("anthropic-messages", "messages"),
            ("openai-responses", "input"),
        ] {
            let body = request(
                "fixture",
                transport,
                "fixture",
                "system",
                &history,
                &[],
                None,
            );
            let items = body[field].as_array().unwrap();
            assert!(
                items
                    .iter()
                    .all(|item| item.get("_v4HostEvidence").is_none()),
                "{transport}"
            );
            assert_eq!(items.last().unwrap()["content"], history[0]["content"]);
        }
        assert_eq!(history, before);
    }

    #[test]
    fn measured_request_contains_the_actual_streaming_option_for_every_transport() {
        for transport in ["openai-chat", "openai-responses", "anthropic-messages"] {
            let body = request("fixture", transport, "fixture", "system", &[], &[], None);
            assert_eq!(body["stream"], true, "{transport}");
        }
    }

    #[test]
    fn provider_output_cannot_create_a_user_or_system_history_record() {
        for role in ["user", "system", "tool"] {
            for (transport, body) in [
                (
                    "openai-chat",
                    json!({"choices":[{"finish_reason":"stop","message":{"role":role,"content":"answer"}}]}),
                ),
                (
                    "openai-responses",
                    json!({"status":"completed","output":[{"type":"message","role":role,"content":[{"type":"output_text","text":"answer"}]}]}),
                ),
            ] {
                let mut history = vec![json!({"role":"user","content":"original"})];
                let before = history.clone();
                assert!(
                    response(transport, body, &mut history).is_err(),
                    "{transport}/{role}"
                );
                assert_eq!(history, before);
            }
        }
    }

    #[test]
    fn provider_authored_history_cannot_forge_host_evidence_metadata() {
        for (transport, body) in [
            (
                "openai-chat",
                json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"answer","_v4HostEvidence":{"version":1}}}]}),
            ),
            (
                "anthropic-messages",
                json!({"stop_reason":"end_turn","content":[{"type":"text","text":"answer","_v4HostEvidence":{"version":1}}]}),
            ),
            (
                "openai-responses",
                json!({"status":"completed","output":[{"type":"message","role":"assistant","_v4HostEvidence":{"version":1},"content":[{"type":"output_text","text":"answer"}]}]}),
            ),
        ] {
            let mut history = Vec::new();
            let (text, calls) = response(transport, body, &mut history).unwrap();
            assert_eq!(text, "answer");
            assert!(calls.is_empty());
            assert!(
                history
                    .iter()
                    .all(|item| item.get("_v4HostEvidence").is_none()),
                "{transport}"
            );
            if transport == "anthropic-messages" {
                assert!(history[0]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item.get("_v4HostEvidence").is_none()));
            }
        }
    }

    #[test]
    fn responses_encrypted_state_options_are_sent_only_to_documented_providers() {
        for provider in ["openai-api", "xai"] {
            let body = request(
                provider,
                "openai-responses",
                "custom",
                "system",
                &[],
                &[],
                None,
            );
            assert_eq!(body["store"], false);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(body["max_output_tokens"], 8192);
        }
        let body = request(
            "actual",
            "openai-responses",
            "custom",
            "system",
            &[],
            &[],
            None,
        );
        assert!(body.get("store").is_none());
        assert!(body.get("include").is_none());
        assert_eq!(body["max_output_tokens"], 8192);
    }
}

pub(super) fn request(
    provider: &str,
    transport: &str,
    model: &str,
    system: &str,
    history: &[Value],
    tools: &[Value],
    reasoning: Option<&str>,
) -> Value {
    let selection = super::provider_config::select(provider, model).ok();
    let output_tokens = selection
        .as_ref()
        .map(|selection| selection.output_tokens)
        .unwrap_or(8192);
    let mut history = map_images(history, |image| {
        if selection
            .as_ref()
            .is_some_and(|selection| selection.image_input == Some(false))
        {
            json!({"type":if transport == "openai-responses" { "input_text" } else { "text" },"text":"Image artifact retained in V4, but image bytes were not supplied to this text-only model. Do not claim to have inspected the image."})
        } else {
            image_content(transport, image)
        }
    });
    for item in &mut history {
        strip_host_evidence(item);
        if transport == "openai-responses" && item["role"] == "user" {
            if let Some(content) = item["content"].as_array_mut() {
                for block in content {
                    if block["type"] == "text" && block["text"].is_string() {
                        block["type"] = json!("input_text");
                    }
                }
            }
        }
    }
    let tools: Vec<_> = tools.iter().map(|tool| match transport {
        "anthropic-messages" => json!({"name":tool["name"],"description":tool["description"],"input_schema":tool["parameters"]}),
        "openai-responses" => json!({"type":"function","name":tool["name"],"description":tool["description"],"parameters":tool["parameters"],"strict":false}),
        _ => json!({"type":"function","function":tool}),
    }).collect();
    match transport {
        "anthropic-messages" => {
            let mut body = json!({"model":model,"stream":true,"system":system,"max_tokens":output_tokens,"messages":history,"tools":tools});
            if let Some(effort) = reasoning {
                body["output_config"] = json!({"effort":effort});
                if let Some(thinking) = selection
                    .as_ref()
                    .and_then(|selection| selection.thinking_on_reasoning.as_ref())
                {
                    body["thinking"] = thinking.clone();
                }
            }
            body
        }
        "openai-responses" => {
            let mut body = json!({"model":model,"stream":true,"instructions":system,"input":history,"tools":tools,"max_output_tokens":output_tokens});
            if selection
                .as_ref()
                .is_some_and(|selection| selection.encrypted_response_state)
            {
                body["store"] = json!(false);
                body["include"] = json!(["reasoning.encrypted_content"]);
            }
            if let Some(effort) = reasoning {
                body["reasoning"] = json!({"effort":effort});
            }
            body
        }
        _ => {
            let mut messages = vec![json!({"role":"system","content":system})];
            messages.extend_from_slice(&history);
            let mut body = json!({"model":model,"stream":true,"messages":messages,"tools":tools,"max_tokens":output_tokens});
            if let Some(effort) = reasoning {
                body["reasoning_effort"] = json!(effort);
                if let Some(thinking) = selection
                    .as_ref()
                    .and_then(|selection| selection.thinking_on_reasoning.as_ref())
                {
                    body["thinking"] = thinking.clone();
                }
            }
            body
        }
    }
}

pub(super) fn response(
    transport: &str,
    body: Value,
    history: &mut Vec<Value>,
) -> Result<(String, Vec<Value>), String> {
    if body.get("error").is_some_and(|v| !v.is_null()) {
        return Err("Provider returned an error; check the model and account settings".into());
    }
    let mut calls = Vec::new();
    let mut texts = Vec::new();
    let items = match transport {
        "anthropic-messages" => {
            if !matches!(
                body["stop_reason"].as_str(),
                Some("end_turn" | "tool_use" | "stop_sequence")
            ) {
                return Err("Provider response was incomplete or refused".into());
            }
            body["content"]
                .as_array()
                .ok_or("Provider returned invalid content")?
                .clone()
        }
        "openai-responses" => {
            if body["status"] != "completed" {
                return Err("Provider response was incomplete or refused".into());
            }
            body["output"]
                .as_array()
                .ok_or("Provider returned invalid output")?
                .clone()
        }
        _ => {
            let choice = &body["choices"][0];
            if !matches!(
                choice["finish_reason"].as_str(),
                Some("stop" | "tool_calls")
            ) {
                return Err("Provider response was incomplete or refused".into());
            }
            let mut message = choice["message"].clone();
            strip_host_evidence(&mut message);
            if message["role"] != "assistant" {
                return Err("Provider returned an invalid assistant role".into());
            }
            if let Some(text) = message["content"].as_str() {
                texts.push(text.to_owned());
            }
            for call in message["tool_calls"].as_array().into_iter().flatten() {
                calls.push(json!({"id":call["id"],"name":call["function"]["name"],"input":serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap_or("")).map_err(|_|"Provider returned invalid tool arguments")?}));
            }
            validate_calls(&calls)?;
            if texts.iter().all(|t| t.trim().is_empty()) && calls.is_empty() {
                return Err("Provider returned no answer or tools".into());
            }
            history.push(message);
            return Ok((texts.join("\n"), calls));
        }
    };
    let items: Vec<_> = items
        .into_iter()
        .map(|mut item| {
            strip_host_evidence(&mut item);
            item
        })
        .collect();
    for item in &items {
        if item["type"] == "message" && item["role"] != "assistant" {
            return Err("Provider returned an invalid assistant role".into());
        }
        match item["type"].as_str() {
            Some("text") => texts.push(item["text"].as_str().unwrap_or("").to_owned()),
            Some("message") => for content in item["content"].as_array().into_iter().flatten() {
                if content["type"]=="output_text" { texts.push(content["text"].as_str().unwrap_or("").to_owned()); }
            },
            Some("tool_use") => calls.push(json!({"id":item["id"],"name":item["name"],"input":item["input"]})),
            Some("function_call") => calls.push(json!({"id":item["call_id"],"name":item["name"],"input":serde_json::from_str::<Value>(item["arguments"].as_str().unwrap_or("")).map_err(|_|"Provider returned invalid tool arguments")?})),
            _=>{}
        }
    }
    validate_calls(&calls)?;
    if texts.iter().all(|t| t.trim().is_empty()) && calls.is_empty() {
        return Err("Provider returned no answer or tools".into());
    }
    if transport == "anthropic-messages" {
        history.push(json!({"role":"assistant","content":items}));
    } else {
        history.extend(items);
    }
    Ok((texts.join("\n"), calls))
}
fn strip_host_evidence(item: &mut Value) {
    if let Some(object) = item.as_object_mut() {
        object.remove("_v4HostEvidence");
        object.remove("_v4UserInput");
    }
}
fn validate_calls(calls: &[Value]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if calls.len() > 16 {
        return Err("Provider exceeded the tool call limit".into());
    }
    for call in calls {
        let id = call["id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 200)
            .ok_or("Invalid tool call ID")?;
        if !ids.insert(id) || !call["input"].is_object() || call["name"].as_str().is_none() {
            return Err("Invalid tool call".into());
        }
    }
    Ok(())
}
fn image_content(transport: &str, value: &Value) -> Value {
    if value["type"] == "image" && value["mimeType"].is_string() && value["data"].is_string() {
        let mime = value["mimeType"].as_str().unwrap();
        let data = value["data"].as_str().unwrap();
        return match transport {
            "anthropic-messages" => {
                json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
            }
            "openai-responses" => {
                json!({"type":"input_image","image_url":format!("data:{mime};base64,{data}"),"detail":"auto"})
            }
            _ => {
                json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{data}")}})
            }
        };
    }
    value.clone()
}
pub(super) fn image_inputs(history: &[Value]) -> Vec<Value> {
    let mut images = Vec::new();
    map_images(history, |image| {
        images.push(image.clone());
        image.clone()
    });
    images
}
pub(super) fn map_images(history: &[Value], mut map: impl FnMut(&Value) -> Value) -> Vec<Value> {
    fn blocks(content: &mut [Value], map: &mut impl FnMut(&Value) -> Value) {
        for block in content {
            if block["type"] == "v4_image"
                || block["type"] == "image"
                    && block["mimeType"].is_string()
                    && block["data"].is_string()
            {
                *block = map(block);
            } else if block["type"] == "tool_result" {
                if let Some(content) = block["content"].as_array_mut() {
                    blocks(content, map);
                }
            }
        }
    }
    let mut history = history.to_vec();
    for item in &mut history {
        if item["role"] == "user" {
            if let Some(content) = item["content"].as_array_mut() {
                blocks(content, &mut map);
            }
        } else if item["type"] == "function_call_output" {
            if let Some(content) = item["output"].as_array_mut() {
                blocks(content, &mut map);
            }
        }
    }
    history
}

pub(super) fn tool_results(transport: &str, results: Vec<Value>, history: &mut Vec<Value>) {
    if transport == "anthropic-messages" {
        let content: Vec<_>=results.into_iter().map(|r|json!({"type":"tool_result","tool_use_id":r["id"],"content":r.get("content").unwrap_or(&r["text"]),"is_error":r["error"]})).collect();
        history.push(json!({"role":"user","content":content}));
    } else if transport == "openai-responses" {
        history.extend(results.into_iter().map(|r| {
            let output = if let Some(content) = r["content"].as_array() {
                Value::Array(
                    content
                        .iter()
                        .map(|item| {
                            if item["type"] == "text" {
                                json!({"type":"input_text","text":item["text"]})
                            } else {
                                item.clone()
                            }
                        })
                        .collect(),
                )
            } else {
                r["text"].clone()
            };
            json!({"type":"function_call_output","call_id":r["id"],"output":output})
        }));
    } else {
        let mut images = Vec::new();
        for r in results {
            history.push(json!({"role":"tool","tool_call_id":r["id"],"content":r["text"]}));
            for item in r["content"].as_array().into_iter().flatten() {
                if matches!(item["type"].as_str(), Some("image" | "v4_image")) {
                    images.push(json!({"type":"text","text":format!("Image returned by tool call {}:",r["id"].as_str().unwrap_or("unknown"))}));
                    images.push(item.clone());
                }
            }
        }
        if !images.is_empty() {
            history.push(json!({"role":"user","content":images}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responses_preserve_reasoning_calls_and_correlate_results() {
        let mut history = vec![json!({"role":"user","content":"Inspect"})];
        let body = json!({"status":"completed","output":[{"type":"reasoning","id":"r","encrypted_content":"opaque"},{"type":"function_call","id":"fc","call_id":"c1","name":"read_file","arguments":"{\"path\":\"README.md\"}"}]});
        let (_, calls) = response("openai-responses", body, &mut history).unwrap();
        assert_eq!(
            calls,
            vec![json!({"id":"c1","name":"read_file","input":{"path":"README.md"}})]
        );
        tool_results(
            "openai-responses",
            vec![json!({"id":"c1","text":"content","error":false})],
            &mut history,
        );
        let body = request(
            "openai-api",
            "openai-responses",
            "model",
            "system",
            &history,
            &[],
            Some("high"),
        );
        assert_eq!(body["input"][1]["encrypted_content"], "opaque");
        assert_eq!(
            body["input"][3],
            json!({"type":"function_call_output","call_id":"c1","output":"content"})
        );
        assert_eq!(body["reasoning"], json!({"effort":"high"}));
        assert_eq!(body["store"], false);
    }
    #[test]
    fn anthropic_results_immediately_follow_all_calls_and_carry_errors() {
        let mut history = vec![json!({"role":"user","content":"Inspect"})];
        let body = json!({"stop_reason":"tool_use","content":[{"type":"tool_use","id":"a","name":"read_file","input":{"path":"a"}},{"type":"tool_use","id":"b","name":"read_file","input":{"path":"b"}}]});
        let (_, calls) = response("anthropic-messages", body, &mut history).unwrap();
        assert_eq!(calls.len(), 2);
        tool_results(
            "anthropic-messages",
            vec![
                json!({"id":"a","text":"one","error":false}),
                json!({"id":"b","text":"denied","error":true}),
            ],
            &mut history,
        );
        assert_eq!(
            history[2],
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"one","is_error":false},{"type":"tool_result","tool_use_id":"b","content":"denied","is_error":true}]})
        );
    }
    #[test]
    fn chat_preserves_provider_reasoning_and_rejects_truncated_or_empty_output() {
        let mut history = vec![];
        let (_, calls)=response("openai-chat",json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"reasoning_content":"provider state","tool_calls":[{"id":"c","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}),&mut history).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(history[0]["reasoning_content"], "provider state");
        for body in [
            json!({"choices":[{"finish_reason":"length","message":{"content":"cut"}}]}),
            json!({"choices":[]}),
            json!({"error":{"message":"private-key"}}),
        ] {
            assert!(response("openai-chat", body, &mut history).is_err());
        }
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;
    #[test]
    fn images_are_provider_content_and_chat_results_stay_contiguous() {
        let results = vec![
            json!({"id":"shot","text":"Screenshot from approved V4 browser","error":false,"content":[{"type":"text","text":"Screenshot from approved V4 browser"},{"type":"image","mimeType":"image/png","data":"AQID"}]}),
            json!({"id":"other","text":"Second result","error":false}),
        ];
        for transport in ["anthropic-messages", "openai-responses", "openai-chat"] {
            let mut history = vec![];
            tool_results(transport, results.clone(), &mut history);
            let body = request(
                "fixture",
                transport,
                "fixture",
                "system",
                &history,
                &[],
                None,
            );
            match transport {
                "anthropic-messages" => assert_eq!(
                    body["messages"][0]["content"][0]["content"][1],
                    json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AQID"}})
                ),
                "openai-responses" => assert_eq!(
                    body["input"][0]["output"],
                    json!([{"type":"input_text","text":"Screenshot from approved V4 browser"},{"type":"input_image","image_url":"data:image/png;base64,AQID","detail":"auto"}])
                ),
                _ => {
                    assert_eq!(body["messages"][1]["role"], "tool");
                    assert_eq!(body["messages"][2]["role"], "tool");
                    assert_eq!(
                        body["messages"][3]["content"][1],
                        json!({"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}})
                    );
                    assert_eq!(
                        body["messages"][3]["content"][0]["text"],
                        "Image returned by tool call shot:"
                    );
                }
            }
        }
    }
    #[test]
    fn persisted_image_refs_are_not_base64_until_hydrated() {
        let image = json!({"type":"v4_image","artifactId":"owned-hash","mimeType":"image/png"});
        let mut history = vec![];
        tool_results(
            "anthropic-messages",
            vec![
                json!({"id":"image","text":"Owned screenshot","error":false,"content":[{"type":"text","text":"Owned screenshot"},image]}),
            ],
            &mut history,
        );
        assert_eq!(history[0]["content"][0]["content"][1]["type"], "v4_image");
        assert!(history[0]["content"][0]["content"][1].get("data").is_none());
    }
}

#[cfg(test)]
mod image_position_tests {
    use super::*;
    #[test]
    fn image_shaped_tool_arguments_and_nested_text_data_are_preserved() {
        let input = json!({"type":"image","mimeType":"image/png","data":"literal argument not an attachment"});
        let history = vec![
            json!({"role":"assistant","content":[{"type":"tool_use","id":"a","name":"example","input":input}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":[{"type":"text","text":"ok","extra":input}]}]}),
        ];
        let body = request(
            "fixture",
            "anthropic-messages",
            "fixture",
            "sys",
            &history,
            &[],
            None,
        );
        assert_eq!(body["messages"][0]["content"][0]["input"], input);
        assert_eq!(
            body["messages"][1]["content"][0]["content"][0]["extra"],
            input
        );
    }
}

#[cfg(test)]
mod user_image_transport_tests {
    use super::*;
    #[test]
    fn image_user_red_mixed_text_and_image_use_each_transport_content_types() {
        let text = "Cafe\u{301}\nsnow \u{2603}";
        let history = vec![
            json!({"role":"user","content":[{"type":"text","text":text},{"type":"image","mimeType":"image/png","data":"AQID"}]}),
        ];
        for transport in ["openai-chat", "openai-responses", "anthropic-messages"] {
            let body = request(
                "fixture",
                transport,
                "fixture",
                "system",
                &history,
                &[],
                None,
            );
            let user = if transport == "openai-chat" {
                &body["messages"][1]
            } else if transport == "openai-responses" {
                &body["input"][0]
            } else {
                &body["messages"][0]
            };
            assert_eq!(user["role"], "user");
            assert_eq!(user["content"][0]["text"], text);
            assert_eq!(
                user["content"][0]["type"],
                if transport == "openai-responses" {
                    "input_text"
                } else {
                    "text"
                }
            );
            assert_eq!(
                user["content"][1]["type"],
                match transport {
                    "openai-responses" => "input_image",
                    "anthropic-messages" => "image",
                    _ => "image_url",
                }
            );
        }
    }
}
