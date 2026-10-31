use super::structured_projection::GuestMessage;
use std::collections::HashSet;
use terminal_v4_core::StructuredSessionEvent;

#[derive(Default)]
struct PrivateKeyScan {
    inside: bool,
    candidate: Vec<u8>,
}

impl PrivateKeyScan {
    fn spans_message(&mut self, content: &str) -> bool {
        const BEGIN: &[u8] = b"-----BEGIN ";
        const END: &[u8] = b"-----END ";
        const MAX_MARKER_BYTES: usize = 256;
        let started_inside = self.inside;
        let carried_candidate = !self.candidate.is_empty();
        let mut crossed_opening = false;
        for byte in content.bytes() {
            if self.candidate.is_empty() && byte != b'-' {
                continue;
            }
            self.candidate.push(byte);
            let complete = self.candidate.ends_with(b"-----")
                && (self.candidate.starts_with(BEGIN) || self.candidate.starts_with(END));
            if complete {
                let private = self.candidate.ends_with(b"PRIVATE KEY-----")
                    || self.candidate.ends_with(b"PRIVATE KEY BLOCK-----");
                if private {
                    self.inside = self.candidate.starts_with(BEGIN);
                    crossed_opening |= self.inside && carried_candidate;
                }
                self.candidate.clear();
                continue;
            }
            let possible = [BEGIN, END].iter().any(|prefix| {
                if prefix.starts_with(&self.candidate) {
                    return true;
                }
                let Some(rest) = self.candidate.strip_prefix(*prefix) else {
                    return false;
                };
                let mut dashes = 0;
                rest.iter().all(|byte| {
                    if *byte == b'-' {
                        dashes += 1;
                        dashes <= 5
                    } else {
                        dashes == 0
                            && (byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b' ')
                    }
                })
            });
            if !possible {
                let suffix = (1..=self.candidate.len().min(BEGIN.len()))
                    .rev()
                    .find(|length| {
                        let suffix = &self.candidate[self.candidate.len() - length..];
                        BEGIN.starts_with(suffix) || END.starts_with(suffix)
                    })
                    .unwrap_or(0);
                self.candidate = self.candidate[self.candidate.len() - suffix..].to_vec();
            } else if self.candidate.len() > MAX_MARKER_BYTES {
                if self.candidate.starts_with(BEGIN) {
                    self.inside = true;
                    crossed_opening = true;
                }
                self.candidate.clear();
            }
        }
        started_inside || self.inside || crossed_opening
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct Cursor<'a> {
    pub(crate) generation: &'a str,
    pub(crate) seq: i64,
}
#[derive(Debug, PartialEq)]
pub(crate) struct Page<'a> {
    pub(crate) cursor: Cursor<'a>,
    pub(crate) messages: Vec<GuestMessage>,
    pub(crate) omitted: usize,
}

pub(crate) fn project_page<'a>(
    events: &[StructuredSessionEvent],
    generation: &'a str,
    cursor: Cursor<'_>,
    max_messages: usize,
    max_bytes: usize,
) -> Result<Page<'a>, &'static str> {
    const MAX_EVENTS: usize = 262_144;
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
    let mut private_key = PrivateKeyScan::default();
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
        let spans_private_key = private_key.spans_message(content);
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
        let text = if spans_private_key {
            "[redacted]".to_owned()
        } else {
            crate::session_search::safe_history_text(content)
        };
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
    fn private_keys_spanning_messages_are_redacted_across_page_boundaries() {
        let message = |seq, text: &str| {
            event(json!({
                "type":"message_completed", "ts":seq, "seq":seq,
                "role":"assistant", "messageId":format!("m{seq}"), "content":text,
            }))
        };
        let events = vec![
            message(
                1,
                "before\n-----BEGIN PRIVATE KEY-----\nfirst-private-fragment",
            ),
            message(2, "middle-private-fragment"),
            message(3, "last-private-fragment\n-----END PRIVATE KEY-----\nafter"),
            message(4, "a safe answer"),
        ];
        let first = project_page(&events, "gen", cursor("gen", 0), 1, 100).unwrap();
        let second = project_page(&events, "gen", cursor("gen", first.cursor.seq), 1, 100).unwrap();
        let third = project_page(&events, "gen", cursor("gen", second.cursor.seq), 1, 100).unwrap();
        let fourth = project_page(&events, "gen", cursor("gen", third.cursor.seq), 1, 100).unwrap();
        assert_eq!(
            [
                first.messages[0].text.as_str(),
                second.messages[0].text.as_str(),
                third.messages[0].text.as_str(),
                fourth.messages[0].text.as_str()
            ],
            ["[redacted]", "[redacted]", "[redacted]", "a safe answer"],
        );
    }

    #[test]
    fn split_private_key_markers_are_reconstructed_across_pages_and_new_events() {
        let marker = "-----BEGIN PRIVATE KEY-----";
        let message = |seq, content: String| {
            event(json!({
                "type":"message_completed", "ts":seq, "seq":seq,
                "role":"assistant", "messageId":format!("m{seq}"), "content":content,
            }))
        };
        for split in 1..marker.len() {
            let first_events = vec![message(1, marker[..split].into())];
            let first = project_page(&first_events, "gen", cursor("gen", 0), 1, 100).unwrap();
            let second_events = vec![
                first_events[0].clone(),
                message(
                    2,
                    format!("{}\nsecret-fragment\n-----END PRI", &marker[split..]),
                ),
            ];
            let second = project_page(
                &second_events,
                "gen",
                cursor("gen", first.cursor.seq),
                1,
                100,
            )
            .unwrap();
            let final_events = vec![
                second_events[0].clone(),
                second_events[1].clone(),
                message(3, "VATE KEY-----\nsensitive-tail".into()),
                message(4, "safe message".into()),
            ];
            let third = project_page(
                &final_events,
                "gen",
                cursor("gen", second.cursor.seq),
                1,
                100,
            )
            .unwrap();
            let fourth = project_page(
                &final_events,
                "gen",
                cursor("gen", third.cursor.seq),
                1,
                100,
            )
            .unwrap();
            assert_eq!(
                [
                    second.messages[0].text.as_str(),
                    third.messages[0].text.as_str(),
                    fourth.messages[0].text.as_str()
                ],
                ["[redacted]", "[redacted]", "safe message"],
                "split at {split}",
            );
        }
    }

    #[test]
    fn private_key_markers_split_one_byte_per_message_do_not_expose_the_body() {
        let chunks = "-----BEGIN RSA PRIVATE KEY-----"
            .chars()
            .map(|character| character.to_string())
            .chain(std::iter::once("private-material".into()))
            .chain(
                "-----END RSA PRIVATE KEY-----"
                    .chars()
                    .map(|character| character.to_string()),
            )
            .chain(std::iter::once("safe".into()))
            .collect::<Vec<_>>();
        let events = chunks
            .iter()
            .enumerate()
            .map(|(index, content)| {
                let seq = index as i64 + 1;
                event(json!({
                    "type":"message_completed", "ts":seq, "seq":seq,
                    "role":"assistant", "messageId":format!("m{seq}"), "content":content,
                }))
            })
            .collect::<Vec<_>>();
        let mut position = 0;
        let mut projected = Vec::new();
        while position < events.len() as i64 {
            let page = project_page(&events, "gen", cursor("gen", position), 1, 100).unwrap();
            position = page.cursor.seq;
            projected.extend(page.messages.into_iter().map(|message| message.text));
        }
        let body = "-----BEGIN RSA PRIVATE KEY-----".len();
        assert_eq!(projected[body], "[redacted]");
        assert!(!projected
            .iter()
            .any(|text| text.contains("private-material")));
        assert_eq!(projected.last().unwrap(), "safe");
    }

    #[test]
    fn non_private_split_headers_do_not_hide_following_messages() {
        let message = |seq, content: &str| {
            event(json!({
                "type":"message_completed", "ts":seq, "seq":seq,
                "role":"assistant", "messageId":format!("m{seq}"), "content":content,
            }))
        };
        let events = vec![
            message(1, "-----BEGIN CERTI"),
            message(2, "FICATE-----\npublic certificate"),
            message(3, "ordinary result"),
        ];
        let page = project_page(&events, "gen", cursor("gen", 0), 10, 200).unwrap();
        assert_eq!(
            page.messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            [
                "-----BEGIN CERTI",
                "FICATE-----\npublic certificate",
                "ordinary result"
            ],
        );
    }

    #[test]
    fn unbounded_private_header_fails_closed_without_growing_parser_state() {
        let mut scanner = PrivateKeyScan::default();
        let header = format!("-----BEGIN {}", "A".repeat(300));
        assert!(scanner.spans_message(&header));
        assert!(scanner.candidate.len() <= 256);
        assert!(scanner.spans_message(" PRIVATE KEY-----\nprivate-material"));
        assert!(scanner.spans_message("-----END PRIVATE KEY-----"));
        assert!(!scanner.spans_message("safe"));
    }

    #[test]
    fn an_omitted_oversized_message_still_marks_following_private_fragments() {
        let message = |seq, text: String| {
            event(json!({
                "type":"message_completed", "ts":seq, "seq":seq,
                "role":"assistant", "messageId":format!("m{seq}"), "content":text,
            }))
        };
        let events = vec![
            message(
                1,
                format!("{}\n-----BEGIN PRIVATE KEY-----", "x".repeat(16_384)),
            ),
            message(2, "private-fragment\n-----END PRIVATE KEY-----".into()),
            message(3, "safe".into()),
        ];
        let page = project_page(&events, "gen", cursor("gen", 0), 10, 100).unwrap();
        assert_eq!(page.omitted, 1);
        assert_eq!(
            page.messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            ["[redacted]", "safe"]
        );
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
