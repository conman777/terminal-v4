use terminal_v4_core::TerminalStreamEvent;

/// A detected conversation turn from terminal output.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatTurn {
    pub role: &'static str,
    pub content: String,
    pub ts: i64,
}

/// Strip all ANSI escape sequences and control characters from a string.
pub fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1b {
            // ESC sequence
            i += 1;
            if i >= len {
                break;
            }
            match bytes[i] {
                b'[' => {
                    // CSI sequence: ESC [ ... final_byte
                    i += 1;
                    while i < len && bytes[i] >= 0x20 && bytes[i] <= 0x3f {
                        i += 1;
                    }
                    if i < len && bytes[i] >= 0x40 && bytes[i] <= 0x7e {
                        i += 1;
                    }
                }
                b']' => {
                    // OSC sequence: ESC ] ... (BEL or ESC \)
                    i += 1;
                    while i < len {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'P' => {
                    // DCS sequence: ESC P ... ESC \
                    i += 1;
                    while i < len {
                        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                b'(' | b')' => {
                    // Character set designation: ESC ( X or ESC ) X
                    i += 1;
                    if i < len {
                        i += 1;
                    }
                }
                b'N' | b'O' => {
                    // Single character escapes
                    i += 1;
                    if i < len {
                        i += 1;
                    }
                }
                _ => {
                    // Other ESC sequences: skip one char
                    i += 1;
                }
            }
        } else if bytes[i] <= 0x08
            || bytes[i] == 0x0b
            || bytes[i] == 0x0c
            || (bytes[i] >= 0x0e && bytes[i] <= 0x1f)
            || bytes[i] == 0x7f
        {
            // Control characters (keep \t=0x09, \n=0x0a, \r=0x0d)
            i += 1;
        } else if bytes[i] >= 0x80 {
            // Multi-byte UTF-8: copy the full character
            let start = i;
            i += 1;
            while i < len && (bytes[i] & 0xC0) == 0x80 {
                i += 1;
            }
            result.push_str(&input[start..i]);
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }

    result
}

/// Returns true if the line looks like Claude Code UI chrome that should be filtered out.
pub fn is_ui_chrome(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }

    // Prompt patterns
    if trimmed == ">" || trimmed == "❯" {
        return true;
    }

    // Token/cost counters
    if trimmed.starts_with("Tokens:") || trimmed.starts_with("Cost:") {
        return true;
    }

    // Thinking indicators
    if trimmed.starts_with("Thinking") && trimmed.ends_with("...") {
        return true;
    }

    // Tool use indicators
    let tool_prefixes = [
        "Read(",
        "Edit(",
        "Write(",
        "Bash(",
        "Glob(",
        "Grep(",
        "Agent(",
        "TodoRead(",
        "TodoWrite(",
        "Search(",
        "ListFiles(",
    ];
    for prefix in &tool_prefixes {
        if trimmed.starts_with(prefix) {
            return true;
        }
    }

    if trimmed.contains('%')
        && trimmed.chars().any(|c| {
            matches!(
                c,
                '\u{2588}'
                    | '\u{2593}'
                    | '\u{2592}'
                    | '\u{2591}'
                    | '\u{2581}'
                    | '\u{2582}'
                    | '\u{2583}'
                    | '\u{2584}'
                    | '\u{2585}'
                    | '\u{2586}'
                    | '\u{2587}'
                    | '\u{2589}'
            )
        })
    {
        return true;
    }

    // Progress/spinner patterns
    if trimmed.starts_with("⠋")
        || trimmed.starts_with("⠙")
        || trimmed.starts_with("⠹")
        || trimmed.starts_with("⠸")
        || trimmed.starts_with("⠼")
        || trimmed.starts_with("⠴")
        || trimmed.starts_with("⠦")
        || trimmed.starts_with("⠧")
        || trimmed.starts_with("⠇")
        || trimmed.starts_with("⠏")
    {
        return true;
    }

    // Control hints
    if trimmed.contains("Ctrl+") || trimmed.contains("ctrl+") {
        return true;
    }

    // Pane separators
    if trimmed
        .chars()
        .all(|c| c == '─' || c == '━' || c == '=' || c == '-')
        && trimmed.len() > 3
    {
        return true;
    }

    false
}

/// Build conversation turns from terminal history events.
/// Detects user input vs assistant output based on prompt patterns.
pub fn build_turns_from_history(entries: &[TerminalStreamEvent]) -> Vec<ChatTurn> {
    let mut turns: Vec<ChatTurn> = Vec::new();
    let mut current_role: &str = "assistant";
    let mut current_content = String::new();
    let mut current_ts: i64 = 0;

    for entry in entries {
        let cleaned = strip_ansi(&entry.text);
        let lines: Vec<&str> = cleaned.lines().collect();

        for line in lines {
            let stripped = line.trim();

            // Detect prompt-only line → next input is user turn
            if is_prompt_line(stripped) {
                // Flush current content
                if !current_content.trim().is_empty() {
                    turns.push(ChatTurn {
                        role: current_role,
                        content: current_content.trim().to_string(),
                        ts: current_ts,
                    });
                }
                current_content.clear();
                current_role = "user";
                current_ts = entry.ts;
                continue;
            }

            if is_ui_chrome(stripped) {
                continue;
            }

            if current_ts == 0 {
                current_ts = entry.ts;
            }

            // If we see substantial content after a user prompt, switch to assistant
            if current_role == "user" && !current_content.is_empty() {
                turns.push(ChatTurn {
                    role: "user",
                    content: current_content.trim().to_string(),
                    ts: current_ts,
                });
                current_content.clear();
                current_role = "assistant";
                current_ts = entry.ts;
            }

            current_content.push_str(stripped);
            current_content.push('\n');
        }
    }

    // Flush remaining
    if !current_content.trim().is_empty() {
        turns.push(ChatTurn {
            role: current_role,
            content: current_content.trim().to_string(),
            ts: current_ts,
        });
    }

    turns
}

fn is_prompt_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed == ">" || trimmed == "❯"
}

/// Detect whether terminal output ends with an idle prompt.
pub fn output_indicates_idle_prompt(output: &str) -> bool {
    let stripped = strip_ansi(output);
    let cleaned = stripped.replace('\r', "");
    let last_line = cleaned.lines().rev().find(|l| !l.trim().is_empty());
    let Some(line) = last_line else {
        return false;
    };
    let trimmed = line.trim();

    // Windows CMD prompt: C:\path>
    if trimmed.ends_with('>')
        && trimmed.len() > 2
        && trimmed.as_bytes().get(1) == Some(&b':')
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
    {
        return true;
    }

    // PowerShell prompt: PS C:\path>
    if trimmed.starts_with("PS ") && trimmed.ends_with('>') {
        return true;
    }

    // Unix prompt: user@host:path$, user@host:path#, or zsh's user@host path %
    if trimmed.contains('@')
        && (trimmed.ends_with('$') || trimmed.ends_with('#') || trimmed.ends_with('%'))
    {
        return true;
    }

    // Claude Code prompt
    if trimmed == ">" || trimmed == "❯" {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        let input = "\x1b[31mred text\x1b[0m";
        assert_eq!(strip_ansi(input), "red text");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        let input = "before\x1b]7;file:///home/user\x07after";
        assert_eq!(strip_ansi(input), "beforeafter");
    }

    #[test]
    fn strip_ansi_preserves_tabs_and_newlines() {
        let input = "line1\n\tindented\n";
        assert_eq!(strip_ansi(input), input);
    }

    #[test]
    fn strip_ansi_removes_control_characters() {
        let input = "hello\x01\x02world";
        assert_eq!(strip_ansi(input), "helloworld");
    }

    #[test]
    fn is_ui_chrome_detects_tool_use() {
        assert!(is_ui_chrome("Read(/some/file.rs)"));
        assert!(is_ui_chrome("  Edit(/some/file.rs)  "));
        assert!(is_ui_chrome("Bash(npm test)"));
    }

    #[test]
    fn is_ui_chrome_detects_prompts() {
        assert!(is_ui_chrome(">"));
        assert!(is_ui_chrome("❯"));
        assert!(is_ui_chrome("  >  "));
    }

    #[test]
    fn is_ui_chrome_detects_spinners() {
        assert!(is_ui_chrome("⠋ Working..."));
    }

    #[test]
    fn is_ui_chrome_ignores_real_content() {
        assert!(!is_ui_chrome("Here is my response about the code."));
        assert!(!is_ui_chrome("function hello() { return 42; }"));
    }

    #[test]
    fn is_ui_chrome_detects_token_counts() {
        assert!(is_ui_chrome("Tokens: 1234 input, 567 output"));
        assert!(is_ui_chrome("Cost: $0.03"));
    }

    #[test]
    fn idle_prompt_detects_windows_cmd() {
        assert!(output_indicates_idle_prompt("C:\\Users\\conor>"));
        assert!(output_indicates_idle_prompt("D:\\projects>"));
    }

    #[test]
    fn idle_prompt_detects_powershell() {
        assert!(output_indicates_idle_prompt("PS C:\\Users\\conor>"));
    }

    #[test]
    fn idle_prompt_detects_unix() {
        assert!(output_indicates_idle_prompt("user@host:~/projects$"));
        assert!(output_indicates_idle_prompt("root@server:/etc#"));
        assert!(output_indicates_idle_prompt("conordart@192-168-1-195 ~ %"));
    }

    #[test]
    fn idle_prompt_detects_claude_code() {
        assert!(output_indicates_idle_prompt(">"));
        assert!(output_indicates_idle_prompt("❯"));
    }

    #[test]
    fn idle_prompt_rejects_non_prompts() {
        assert!(!output_indicates_idle_prompt("echo hello"));
        assert!(!output_indicates_idle_prompt("npm run build"));
    }

    #[test]
    fn idle_prompt_strips_ansi_before_checking() {
        assert!(output_indicates_idle_prompt("\x1b[32muser@host:~$\x1b[0m"));
    }

    #[test]
    fn build_turns_empty_input() {
        let turns = build_turns_from_history(&[]);
        assert!(turns.is_empty());
    }

    #[test]
    fn build_turns_user_then_assistant() {
        let events = vec![
            TerminalStreamEvent {
                text: ">\nhello".to_string(),
                ts: 1000,
                seq: None,
            },
            TerminalStreamEvent {
                text: "Hi there! How can I help?".to_string(),
                ts: 2000,
                seq: None,
            },
        ];
        let turns = build_turns_from_history(&events);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert!(turns[0].content.contains("hello"));
        assert_eq!(turns[1].role, "assistant");
        assert!(turns[1].content.contains("Hi there"));
    }

    #[test]
    fn strip_ansi_handles_empty_string() {
        assert_eq!(strip_ansi(""), "");
    }

    #[test]
    fn strip_ansi_handles_utf8() {
        let input = "Hello 世界 🌍";
        assert_eq!(strip_ansi(input), input);
    }

    #[test]
    fn is_ui_chrome_detects_progress_bars() {
        assert!(is_ui_chrome("████████░░░░ 67%"));
        assert!(is_ui_chrome("[████████░░░░] 67%"));
    }

    #[test]
    fn idle_prompt_handles_trailing_whitespace() {
        assert!(output_indicates_idle_prompt("C:\\Users\\conor>  \n"));
    }
}
