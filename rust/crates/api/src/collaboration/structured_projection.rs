use regex_lite::Regex;
use serde::Serialize;
#[cfg(test)]
use std::collections::HashSet;
use std::sync::OnceLock;
#[cfg(test)]
use terminal_v4_core::StructuredSessionEvent;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuestMessage {
    pub(crate) seq: i64,
    pub(crate) role: &'static str,
    pub(crate) text: String,
}

pub(crate) const MAX_GUEST_MESSAGE_BYTES: usize = 16 * 1024;

struct Patterns {
    url_fragment: Regex,
    url_userinfo: Regex,
    url_query: Regex,
    bearer: Regex,
    own_credential: Regex,
    known_key: Regex,
    env_assignment: Regex,
    file_url: Regex,
    path: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        url_fragment: Regex::new(r"(https?://[^\s#]+)#\S*").unwrap(),
        url_userinfo: Regex::new(r"(https?://)[^/\s@]+@").unwrap(),
        url_query: Regex::new(r#"(?i)([?&;][a-z0-9_.-]*(?:token|secret|key|password|passwd|pwd|auth|sig|credential|session|code)[a-z0-9_.-]*=)[^&\s#"')]*"#).unwrap(),
        bearer: Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}").unwrap(),
        own_credential: Regex::new(r"\btv4[a-z]+\.[A-Za-z0-9_-]{8,}").unwrap(),
        known_key: Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bnpm_[A-Za-z0-9]{30,}|\bya29\.[A-Za-z0-9._-]{20,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9_]{8,}").unwrap(),
        env_assignment: Regex::new(r#"\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|[^\s"']+)"#).unwrap(),
        file_url: Regex::new(r#"file://[^\s"'`)\]<>]*"#).unwrap(),
        path: Regex::new(r##"(?m)(^|[\s"'`(\[{=,;:|<>])(?:/(?:Users|home|root|private|var|tmp|etc|opt|mnt|srv|usr|Volumes|workspaces?|Library|Applications|nix|snap|proc)(?:/[^\s"'`)\]<>]*)?|~/[^\s"'`)\]<>]*|[A-Za-z]:\\[^\s"'`)\]<>]*|\\\\[^\s"'`)\]<>]+)"##).unwrap(),
    })
}

fn is_invisible(character: char) -> bool {
    matches!(character,
        '\u{00AD}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

fn redact_long_tokens(text: &str) -> String {
    let secret_like = |word: &str| {
        word.len() >= 32
            && word
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'=' | b'_'))
            && word.bytes().any(|byte| byte.is_ascii_digit())
            && word.bytes().any(|byte| byte.is_ascii_alphabetic())
    };
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if !word.is_empty() {
            out.push_str(if secret_like(word) {
                "[redacted]"
            } else {
                word
            });
            word.clear();
        }
    };
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '+' | '=' | '_') {
            word.push(character);
        } else {
            flush(&mut word, &mut out);
            out.push(character);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn truncate_to_boundary(text: &mut String, max: usize) {
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n[truncated]");
    }
}

pub(crate) fn guest_text(content: &str) -> String {
    let visible: String = content
        .chars()
        .filter(|character| !is_invisible(*character))
        .collect();
    let p = patterns();
    let text = p.url_fragment.replace_all(&visible, "$1");
    let text = p.url_userinfo.replace_all(&text, "${1}[redacted]@");
    let text = p.url_query.replace_all(&text, "${1}[redacted]");
    let text = crate::session_search::safe_history_text(&text);
    let text = p.bearer.replace_all(&text, "$1 [redacted]");
    let text = p.own_credential.replace_all(&text, "[redacted]");
    let text = p.known_key.replace_all(&text, "[redacted]");
    let text = p.env_assignment.replace_all(&text, "${1}=[redacted]");
    let text = p.file_url.replace_all(&text, "[path]");
    let text = p.path.replace_all(&text, "${1}[path]");
    let mut text = redact_long_tokens(&text);
    truncate_to_boundary(&mut text, MAX_GUEST_MESSAGE_BYTES);
    text
}

pub(crate) fn strip_workspace(text: String, workspace: &str) -> String {
    let root = workspace.trim_end_matches('/');
    if root.len() < 3 || !text.contains(root) {
        return text;
    }
    text.replace(root, "[workspace]")
}

#[cfg(test)]
#[derive(Debug, Serialize, PartialEq)]
struct GuestHistory {
    messages: Vec<GuestMessage>,
    omitted: usize,
}

#[cfg(test)]
fn project_guest_history(events: &[StructuredSessionEvent]) -> GuestHistory {
    const MAX_MESSAGE_BYTES: usize = MAX_GUEST_MESSAGE_BYTES;
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
        let text = guest_text(content);
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
    #[test]
    fn guest_text_redacts_adversarial_secrets_paths_and_credentials() {
        let hex = "a".repeat(64);
        let cases: Vec<(String, &str)> = vec![
            (format!("see tv4share.{hex} now"), "tv4share."),
            (format!("see tv4pair.{hex}"), "tv4pair."),
            (
                "Authorization is Bearer abcdefghijklmnop0123456789".into(),
                "abcdefghijklmnop",
            ),
            (
                "curl -H 'Basic dXNlcjpwYXNzd29yZDEyMzQ1'".into(),
                "dXNlcjpw",
            ),
            (
                "key AKIAIOSFODNN7EXAMPLE here".into(),
                "AKIAIOSFODNN7EXAMPLE",
            ),
            ("slack xoxb-1234567890-abcdefghij".into(), "xoxb-"),
            (
                "pat github_pat_11ABCDEFG0123456789abcdefgh".into(),
                "github_pat_11",
            ),
            ("stripe sk_live_abcdef12345678".into(), "sk_live_"),
            ("gl glpat-abcdefghijklmnop1234".into(), "glpat-abc"),
            (
                "npm npm_abcdefghijklmnopqrstuvwxyz0123456789".into(),
                "npm_abc",
            ),
            (
                "clone https://x-access-token@github.com/a/b".into(),
                "x-access-token",
            ),
            (
                "clone https://user:hunter2@github.com/a/b".into(),
                "hunter2",
            ),
            (
                "open https://example.com/cb?access_token=SECRETVALUE&x=1".into(),
                "SECRETVALUE",
            ),
            (
                "open https://example.com/#share=abc.SECRETFRAG".into(),
                "SECRETFRAG",
            ),
            (
                "run DATABASE_URL=postgres://u:p@h/db npm start".into(),
                "postgres://",
            ),
            (
                "export HOME_DIR='/some secret place' ok".into(),
                "secret place",
            ),
            (
                "see /Users/conor/secret-project/src/main.rs:12".into(),
                "secret-project",
            ),
            ("see /home/alice/.ssh/id_rsa".into(), "alice"),
            ("see ~/Documents/taxes.pdf".into(), "taxes"),
            ("see C:\\Users\\Conor\\taxes.txt".into(), "taxes"),
            ("see file:///private/var/folders/x/y".into(), "folders"),
            ("(\"/tmp/build-abc/out.log\")".into(), "build-abc"),
            (
                "blob 0123456789abcdef0123456789abcdef01234567 end".into(),
                "0123456789abcdef0123",
            ),
            (
                "b64 QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmM= end".into(),
                "QWxhZGRpbjp",
            ),
            ("ap\u{200b}i_key=zero-width-secret".into(), "zero-width"),
            ("tok\u{202e}en: reversed-secret".into(), "reversed-secret"),
            (
                "\u{1b}[31mpassword: ansi-secret\u{1b}[0m".into(),
                "ansi-secret",
            ),
            (
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----"
                    .into(),
                "AAAAB3Nza",
            ),
            (
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl".into(),
                "eyJhbGci",
            ),
        ];
        for (input, leaked) in cases {
            let output = guest_text(&input);
            assert!(!output.contains(leaked), "leaked {leaked:?} in {output:?}");
        }
    }

    #[test]
    fn guest_text_keeps_ordinary_conversation_intact() {
        for text in [
            "I updated 3 files and the tests pass.",
            "Call /api/health, then read https://example.com/docs/page?page=2.",
            "Use /run tests and e.g. and/or are fine.",
            "Commit message: fix(auth): handle expiry",
            "Price is ~5 dollars; version 1.2.3 uses NODE ok",
        ] {
            assert_eq!(guest_text(text), text);
        }
    }

    #[test]
    fn guest_text_output_is_bounded_even_when_redaction_expands_the_text() {
        let output = guest_text(&"ABC=1 ".repeat(MAX_GUEST_MESSAGE_BYTES / 6));
        assert!(output.len() <= MAX_GUEST_MESSAGE_BYTES + "\n[truncated]".len());
        assert!(output.ends_with("[truncated]"));
        let multibyte = guest_text(&"é".repeat(MAX_GUEST_MESSAGE_BYTES));
        assert!(multibyte.len() <= MAX_GUEST_MESSAGE_BYTES + "\n[truncated]".len());
    }

    #[test]
    fn strip_workspace_hides_the_workspace_root_but_not_short_roots() {
        assert_eq!(
            strip_workspace(
                "edit /data/projects/app/src/a.rs".into(),
                "/data/projects/app/"
            ),
            "edit [workspace]/src/a.rs"
        );
        assert_eq!(strip_workspace("a / b".into(), "/"), "a / b");
        assert_eq!(strip_workspace("keep".into(), ""), "keep");
    }
}
