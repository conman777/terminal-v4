use super::structured_projection::GuestMessage;
use std::collections::HashSet;
use terminal_v4_core::StructuredSessionEvent;

#[derive(Debug, PartialEq)]
struct Cursor<'a> {
    generation: &'a str,
    seq: i64,
}
#[derive(Debug, PartialEq)]
struct Page<'a> {
    cursor: Cursor<'a>,
    messages: Vec<GuestMessage>,
    omitted: usize,
}

fn project_page<'a>(
    events: &[StructuredSessionEvent],
    generation: &'a str,
    cursor: Cursor<'_>,
    max_messages: usize,
    max_bytes: usize,
) -> Result<Page<'a>, &'static str> {
    const MAX_EVENTS: usize = 32_768;
    const MAX_MESSAGE_BYTES: usize = 16 * 1024;
    const MAX_PAGE_BYTES: usize = 512 * 1024;
    if generation.is_empty()
        || generation.len() > 128
        || generation != cursor.generation
        || events.len() > MAX_EVENTS
        || !(1..=500).contains(&max_messages)
        || !(1..=MAX_PAGE_BYTES).contains(&max_bytes)
        || cursor.seq < 0
        || cursor.seq as usize > events.len()
    {
        return Err("invalid cursor or page bounds");
    }
    if events
        .iter()
        .enumerate()
        .any(|(index, event)| event.seq() != index as i64 + 1)
    {
        return Err("snapshot sequence is incomplete or unordered");
    }
    let mut page = Page {
        cursor: Cursor {
            generation,
            seq: cursor.seq,
        },
        messages: Vec::new(),
        omitted: 0,
    };
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for event in events {
        let seq = event.seq();
        let message = match event {
            StructuredSessionEvent::UserMessageAccepted {
                message_id,
                content,
                ..
            } => Some(("user", Some(message_id.as_str()), content.as_str())),
            StructuredSessionEvent::MessageCompleted {
                role,
                message_id,
                content,
                ..
            } if role == "user" || role == "assistant" => Some((
                if role == "user" { "user" } else { "assistant" },
                message_id.as_deref(),
                content.as_str(),
            )),
            _ => None,
        };
        let Some((role, id, content)) = message else {
            if seq > cursor.seq {
                page.cursor.seq = seq;
            }
            continue;
        };
        if id.is_some_and(|id| seen.contains(&(role, id))) {
            if seq > cursor.seq {
                page.cursor.seq = seq;
            }
            continue;
        }
        if seq <= cursor.seq {
            if let Some(id) = id {
                seen.insert((role, id));
            }
            continue;
        }
        if content.len() > MAX_MESSAGE_BYTES {
            if let Some(id) = id {
                seen.insert((role, id));
            }
            page.omitted += 1;
            page.cursor.seq = seq;
            continue;
        }
        let text = crate::session_search::safe_history_text(content);
        if !page.messages.is_empty()
            && (page.messages.len() >= max_messages || bytes + text.len() > max_bytes)
        {
            break;
        }
        if let Some(id) = id {
            seen.insert((role, id));
        }
        if text.len() > max_bytes {
            page.omitted += 1;
        } else {
            bytes += text.len();
            page.messages.push(GuestMessage { seq, role, text });
        }
        page.cursor.seq = seq;
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(value: serde_json::Value) -> StructuredSessionEvent {
        serde_json::from_value(value).unwrap()
    }
    fn cursor(generation: &str, seq: i64) -> Cursor<'_> {
        Cursor { generation, seq }
    }

    #[test]
    fn pages_replay_exactly_across_duplicate_and_hidden_events() {
        let events = vec![
            event(
                json!({"type":"user_message_accepted","ts":1,"seq":1,"requestId":"request","turnId":"turn","messageId":"user","content":"first"}),
            ),
            event(
                json!({"type":"message_completed","ts":2,"seq":2,"role":"user","messageId":"user","content":"first"}),
            ),
            event(
                json!({"type":"tool_output","ts":3,"seq":3,"toolName":"Tool","output":"private"}),
            ),
            event(
                json!({"type":"message_completed","ts":4,"seq":4,"role":"assistant","messageId":"a","content":"second"}),
            ),
            event(
                json!({"type":"message_delta","ts":5,"seq":5,"role":"assistant","messageId":"b","content":"private fragment"}),
            ),
            event(
                json!({"type":"message_completed","ts":6,"seq":6,"role":"assistant","messageId":"b","content":"third"}),
            ),
        ];
        let first = project_page(&events, "gen-1", cursor("gen-1", 0), 1, 100).unwrap();
        assert_eq!(
            first,
            Page {
                cursor: cursor("gen-1", 3),
                messages: vec![GuestMessage {
                    seq: 1,
                    role: "user",
                    text: "first".into()
                }],
                omitted: 0
            }
        );
        let second = project_page(&events, "gen-1", cursor("gen-1", 3), 1, 100).unwrap();
        assert_eq!(
            second,
            Page {
                cursor: cursor("gen-1", 5),
                messages: vec![GuestMessage {
                    seq: 4,
                    role: "assistant",
                    text: "second".into()
                }],
                omitted: 0
            }
        );
        assert_eq!(
            second,
            project_page(&events, "gen-1", cursor("gen-1", 3), 1, 100).unwrap()
        );
        let third = project_page(&events, "gen-1", cursor("gen-1", 5), 1, 100).unwrap();
        assert_eq!(
            third,
            Page {
                cursor: cursor("gen-1", 6),
                messages: vec![GuestMessage {
                    seq: 6,
                    role: "assistant",
                    text: "third".into()
                }],
                omitted: 0
            }
        );
    }

    #[test]
    fn rejects_stale_future_invalid_or_incomplete_snapshots() {
        let make = |seq| {
            event(
                json!({"type":"message_completed","ts":seq,"seq":seq,"role":"assistant","content":"answer"}),
            )
        };
        let events = vec![make(1), make(2)];
        assert!(project_page(&events, "gen-2", cursor("gen-1", 1), 10, 100).is_err());
        assert!(project_page(&events, "gen-1", cursor("gen-1", 3), 10, 100).is_err());
        assert!(project_page(&events, "gen-1", cursor("gen-1", -1), 10, 100).is_err());
        assert!(project_page(&[make(2)], "gen-1", cursor("gen-1", 0), 10, 100).is_err());
        assert!(project_page(&[make(1), make(3)], "gen-1", cursor("gen-1", 1), 10, 100).is_err());
        assert!(project_page(&[make(1), make(1)], "gen-1", cursor("gen-1", 1), 10, 100).is_err());
        assert!(project_page(&events, "gen-1", cursor("gen-1", 0), 0, 100).is_err());
        assert!(project_page(&events, "gen-1", cursor("gen-1", 0), 501, 100).is_err());
        assert!(project_page(&events, "gen-1", cursor("gen-1", 0), 1, 0).is_err());
    }

    #[test]
    fn bounded_pages_do_not_cut_utf8_and_report_omissions() {
        let make = |seq, text| {
            event(
                json!({"type":"message_completed","ts":seq,"seq":seq,"role":"assistant","messageId":format!("{seq}"),"content":text}),
            )
        };
        let events = vec![
            make(1, "éé".to_string()),
            make(2, "éé".to_string()),
            make(3, "x".repeat(16_385)),
            make(4, "api_key=secret".to_string()),
        ];
        let first = project_page(&events, "gen", cursor("gen", 0), 10, 7).unwrap();
        assert_eq!(first.cursor.seq, 1);
        assert_eq!(first.messages[0].text, "éé");
        let second = project_page(&events, "gen", cursor("gen", 1), 10, 7).unwrap();
        assert_eq!(second.cursor.seq, 3);
        assert_eq!(second.omitted, 1);
        let third = project_page(&events, "gen", cursor("gen", 3), 10, 100).unwrap();
        assert_eq!(third.messages[0].text, "[redacted]");
    }

    #[test]
    fn reconnect_reads_newly_appended_messages_and_advances_over_hidden_events() {
        let make = |seq, text| {
            event(
                json!({"type":"message_completed","ts":seq,"seq":seq,"role":"assistant","messageId":format!("{seq}"),"content":text}),
            )
        };
        let initial = vec![make(1, "first")];
        let first = project_page(&initial, "gen", cursor("gen", 0), 10, 100).unwrap();
        assert_eq!(first.cursor.seq, 1);
        let current = vec![
            make(1, "first"),
            event(
                json!({"type":"tool_output","ts":2,"seq":2,"toolName":"Tool","output":"private"}),
            ),
            make(3, "second"),
        ];
        let resumed =
            project_page(&current, "gen", cursor("gen", first.cursor.seq), 10, 100).unwrap();
        assert_eq!(
            resumed,
            Page {
                cursor: cursor("gen", 3),
                messages: vec![GuestMessage {
                    seq: 3,
                    role: "assistant",
                    text: "second".into()
                }],
                omitted: 0
            }
        );
        let caught_up = project_page(&current, "gen", cursor("gen", 3), 10, 100).unwrap();
        assert_eq!(
            caught_up,
            Page {
                cursor: cursor("gen", 3),
                messages: vec![],
                omitted: 0
            }
        );
    }
}
