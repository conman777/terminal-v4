pub(crate) fn provider_failed(provider: &str, stdout: &str) -> bool {
    let mut failed = false;
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match (provider, event["type"].as_str()) {
            ("claude", Some("result")) => {
                failed = event["is_error"] == true
                    || event["subtype"]
                        .as_str()
                        .is_some_and(|value| value.starts_with("error_"))
            }
            ("codex", Some("error" | "turn.failed")) => failed = true,
            ("codex", Some("turn.completed")) => failed = false,
            (_, Some("v4.result")) if crate::v4_agent::supports(provider) => {
                failed = event["is_error"] == true
            }
            _ => {}
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_protocol_failure_is_detected_without_interpreting_answer_text() {
        assert!(provider_failed(
            "claude",
            r#"{"type":"result","is_error":true,"result":"Permission required"}"#
        ));
        assert!(provider_failed(
            "codex",
            r#"{"type":"turn.failed","error":{"message":"Auth failed"}}"#
        ));
        assert!(!provider_failed(
            "codex",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Example: turn.failed"}}"#
        ));
        assert!(!provider_failed(
            "hermes",
            "An example error in code is expected."
        ));
    }

    #[test]
    fn completed_retry_supersedes_transient_errors_and_partial_events_are_ignored() {
        let retried =
            "{\"type\":\"error\",\"message\":\"retrying\"}\n{\"type\":\"turn.completed\"}";
        assert!(!provider_failed("codex", retried));
        assert!(provider_failed(
            "codex",
            "{\"type\":\"error\",\"message\":\"unrecoverable\"}"
        ));
        assert!(!provider_failed(
            "claude",
            "{\"type\":\"result\",\"is_error\":true"
        ));
    }
}
