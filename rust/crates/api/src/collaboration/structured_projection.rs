use serde::Serialize;
use std::collections::HashSet;
use terminal_v4_core::StructuredSessionEvent;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GuestMessage {
    pub(super) seq: i64,
    pub(super) role: &'static str,
    pub(super) text: String,
}

#[derive(Debug, Serialize, PartialEq)]
struct GuestHistory {
    messages: Vec<GuestMessage>,
    omitted: usize,
}

fn project_guest_history(events: &[StructuredSessionEvent]) -> GuestHistory {
    const MAX_MESSAGE_BYTES: usize = 16 * 1024;
    const MAX_HISTORY_BYTES: usize = 512 * 1024;
    const MAX_MESSAGES: usize = 500;

    let mut history = GuestHistory {
        messages: Vec::new(),
        omitted: 0,
    };
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    for event in events {
        let (seq, role, message_id, content) = match event {
            StructuredSessionEvent::UserMessageAccepted {
                seq,
                message_id,
                content,
                ..
            } => (*seq, "user", Some(message_id.as_str()), content.as_str()),
            StructuredSessionEvent::MessageCompleted {
                seq,
                role,
                message_id,
                content,
                ..
            } if role == "user" || role == "assistant" => (
                *seq,
                if role == "user" { "user" } else { "assistant" },
                message_id.as_deref(),
                content.as_str(),
            ),
            _ => continue,
        };
        if message_id.is_some_and(|id| !seen.insert((role, id))) {
            continue;
        }
        if content.len() > MAX_MESSAGE_BYTES {
            history.omitted += 1;
            continue;
        }
        let text = crate::session_search::safe_history_text(content);
        if history.messages.len() >= MAX_MESSAGES
            || bytes.saturating_add(text.len()) > MAX_HISTORY_BYTES
        {
            history.omitted += 1;
            continue;
        }
        bytes += text.len();
        history.messages.push(GuestMessage { seq, role, text });
    }
    history
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn event(value: Value) -> StructuredSessionEvent {
        serde_json::from_value(value).expect("synthetic event")
    }

    #[test]
    fn projects_only_completed_conversation_text_without_private_event_metadata() {
        let events = vec![
            event(
                json!({"type":"user_message_accepted","ts":1,"seq":1,"requestId":"request-secret", "turnId":"turn-1", "messageId":"user-1", "content":"Hello", "attachments":[{"attachmentId":"private-attachment", "artifactId":"private-artifact", "mimeType":"image/png", "bytes":42, "name":"private.png"}]}),
            ),
            event(
                json!({"type":"message_completed","ts":2,"seq":2,"role":"user","messageId":"user-1","turnId":"turn-1","content":"Hello"}),
            ),
            event(
                json!({"type":"tool_started","ts":3,"seq":3,"toolName":"Bash","toolInput":{"password":"private-tool-input"}}),
            ),
            event(
                json!({"type":"message_delta","ts":4,"seq":4,"role":"assistant","messageId":"assistant-1","content":"unfinished private output"}),
            ),
            event(
                json!({"type":"message_completed","ts":5,"seq":5,"role":"reasoning","messageId":"reason-1","content":"private reasoning"}),
            ),
            event(
                json!({"type":"message_completed","ts":6,"seq":6,"role":"assistant","messageId":"assistant-1","turnId":"turn-1","content":"Answer\napi_key=private-secret"}),
            ),
            event(
                json!({"type":"tool_output","ts":7,"seq":7,"toolName":"Bash","output":"private-tool-output"}),
            ),
            event(
                json!({"type":"approval_required","ts":8,"seq":8,"toolName":"Bash","toolInput":{},"description":"private-approval"}),
            ),
        ];
        let projection = project_guest_history(&events);
        assert_eq!(
            projection,
            GuestHistory {
                messages: vec![
                    GuestMessage {
                        seq: 1,
                        role: "user",
                        text: "Hello".into()
                    },
                    GuestMessage {
                        seq: 6,
                        role: "assistant",
                        text: "Answer\n[redacted]".into()
                    },
                ],
                omitted: 0
            }
        );
        let encoded = serde_json::to_string(&projection).unwrap();
        for private in [
            "private-attachment",
            "private-artifact",
            "private.png",
            "private-tool-input",
            "private-tool-output",
            "private-approval",
            "private reasoning",
            "unfinished private output",
            "private-secret",
            "request-secret",
            "turn-1",
        ] {
            assert!(!encoded.contains(private), "leaked {private}");
        }
    }

    #[test]
    fn omits_oversized_messages_and_limits_total_output_without_cutting_utf8() {
        let events: Vec<_> = (1..=600).map(|seq| event(json!({"type":"message_completed","ts":seq,"seq":seq,"role":"assistant","messageId":format!("m-{seq}"),"content":"é".repeat(1024)}))).chain(std::iter::once(event(json!({"type":"message_completed","ts":601,"seq":601,"role":"assistant","messageId":"large","content":"x".repeat(20_000)})))).collect();
        let projection = project_guest_history(&events);
        assert_eq!(projection.messages.len(), 256);
        assert_eq!(projection.omitted, 345);
        assert!(projection
            .messages
            .iter()
            .all(|message| message.text == "é".repeat(1024)));
    }

    #[test]
    fn limits_number_of_short_messages() {
        let events: Vec<_> = (1..=501)
            .map(|seq| event(json!({"type":"message_completed","ts":seq,"seq":seq,"role":"assistant","messageId":format!("m-{seq}"),"content":"ok"})))
            .collect();
        let projection = project_guest_history(&events);
        assert_eq!((projection.messages.len(), projection.omitted), (500, 1));
    }
}
