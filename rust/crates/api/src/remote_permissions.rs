use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Capabilities {
    #[serde(default)]
    pub terminal_input: bool,
    #[serde(default)]
    pub file_write: bool,
    #[serde(default)]
    pub agent_execute: bool,
    #[serde(default)]
    pub tunnels: bool,
    #[serde(default)]
    pub desktop_view: bool,
    #[serde(default)]
    pub desktop_control: bool,
    #[serde(default)]
    pub transfer: bool,
    #[serde(default)]
    pub recordings: bool,
}
impl Capabilities {
    pub(crate) fn observer() -> Self {
        Self::default()
    }
    pub(crate) fn operator() -> Self {
        Self {
            terminal_input: true,
            file_write: true,
            agent_execute: true,
            transfer: true,
            recordings: true,
            ..Self::default()
        }
    }
    pub(crate) fn allows_http(&self, method: &str, path: &str) -> bool {
        if path.contains('%')
            || path.contains('\\')
            || path.contains("//")
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| matches!(part, "." | ".."))
        {
            return false;
        }
        let read = matches!(method, "GET" | "HEAD");
        let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
        match parts.as_slice() {
            ["api", "state" | "latency", ..]
                if path == "/api/state" || path == "/api/latency/ws" =>
            {
                read
            }
            ["api", "agent", "catalog" | "auth"] => read,
            ["api", "system", "stats"] | ["api", "system", "stats", "history"] => read,
            ["api", "terminal"] => read || (method == "POST" && self.terminal_input),
            ["api", "terminal", _] => matches!(method, "PATCH" | "DELETE") && self.terminal_input,
            ["api", "terminal", _, action] => match *action {
                "history" | "stream" | "turns" | "thread" | "git-branches" | "project-info"
                | "git-stats" | "ws" => {
                    read || (method == "PATCH" && *action == "thread" && self.terminal_input)
                }
                "git-checkout" => method == "POST" && self.file_write,
                "generate-topic" => method == "POST" && self.agent_execute,
                "input" | "resize" | "restore" | "detect-project" => {
                    method == "POST" && self.terminal_input
                }
                _ => false,
            },
            ["api", "structured", "sessions", tail @ ..] => {
                if read {
                    tail.len() <= 1 || (tail.len() == 2 && matches!(tail[1], "thread" | "ws"))
                } else {
                    self.agent_execute
                        && matches!(method, "POST" | "PATCH" | "DELETE")
                        && tail.len() <= 2
                }
            }
            ["api", "fs", "list"] | ["api", "files", "list"] => read,
            ["api", "files", "download"] | ["api", "fs", "download"] => read && self.transfer,
            ["api", "files", "upload" | "screenshot"] => {
                method == "POST" && self.transfer && self.file_write
            }
            ["api", "files", "mkdir" | "rename" | "unzip"] => method == "POST" && self.file_write,
            ["api", "files", "delete"] => matches!(method, "POST" | "DELETE") && self.file_write,
            ["api", "projects", "scan" | "scan-dirs"] => {
                read || (method == "POST" && path.ends_with("scan-dirs") && self.file_write)
            }
            ["api", "workspace", tail @ ..] => {
                if read {
                    matches!(
                        tail,
                        ["profile" | "history" | "skills" | "proposals" | "rewind" | "tasks"]
                            | ["git", "status" | "diff" | "worktrees" | "checkpoints"]
                            | ["native-history", "sources" | "imports"]
                            | ["native-history", "imports", _]
                    )
                } else if tail.first() == Some(&"rewind") {
                    self.agent_execute && self.file_write && self.terminal_input && method == "POST"
                } else if matches!(tail.first(), Some(&"tasks" | &"schedules")) {
                    self.agent_execute && matches!(method, "POST" | "PATCH" | "DELETE")
                } else if matches!(tail.first(), Some(&"git" | &"profile" | &"proposals")) {
                    self.file_write && matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
                } else {
                    tail == ["native-history", "import"] && method == "POST" && self.file_write
                }
            }
            ["preview", ..] => read || self.terminal_input,
            ["api", "preview"] => read,
            ["api", "preview", "session"] => false,
            ["api", "preview", _, "cookies" | "proxy-logs" | "storage" | "process-logs"]
                if read =>
            {
                self.agent_execute
            }
            ["api", "preview", _, "evaluate" | "storage" | "screenshot"] => {
                self.agent_execute && method == "POST"
            }
            ["api", "preview", _, "logs" | "performance"] => read || method == "POST",
            ["api", "preview", _, "log-stream" | "performance", "stream"] => read,
            ["api", "preview", "logs" | "active-ports"] | ["api", "preview", _, "log-stream"] => {
                read
            }
            ["api", "proxy-external"] => read,
            ["api", "transfers", "download"] | ["api", "transfers", _, "download-complete"]
                if method == "POST" =>
            {
                self.transfer
            }
            ["api", "transfers", _] if method == "DELETE" => self.transfer,
            ["api", "transfers", ..] => self.transfer && (read || self.file_write),
            ["api", "recordings", ..] => {
                self.recordings
                    && (read || (self.terminal_input && matches!(method, "POST" | "DELETE")))
            }
            ["api", "tunnels", ..] => self.tunnels,
            ["api", "desktop", "sessions"] if method == "POST" => self.desktop_view,
            ["api", "desktop", "sessions", _] if method == "DELETE" => self.desktop_view,
            ["api", "desktop", tail @ ..] => {
                if read {
                    self.desktop_view
                } else {
                    self.desktop_control && self.desktop_view && !tail.is_empty()
                }
            }
            _ => false,
        }
    }
    pub(crate) fn allows_terminal_message(&self, kind: &str) -> bool {
        kind == "ping" || (self.terminal_input && matches!(kind, "input" | "resize"))
    }
    pub(crate) fn allows_structured_message(&self, kind: &str) -> bool {
        kind == "ping"
            || (self.agent_execute
                && matches!(
                    kind,
                    "input" | "message" | "interrupt" | "approve" | "approval"
                ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_grants_cannot_mint_credentials_and_downloads_allow_cleanup() {
        for caps in [Capabilities::observer(), Capabilities::operator()] {
            assert!(!caps.allows_http("POST", "/api/preview/session"));
            assert!(caps.allows_http("GET", "/api/preview/active-ports"));
            assert!(caps.allows_http("HEAD", "/api/preview/active-ports"));
        }
        let transfer = Capabilities {
            transfer: true,
            ..Capabilities::observer()
        };
        assert!(transfer.allows_http("DELETE", "/api/transfers/record-id"));
        assert!(!transfer.allows_http("POST", "/api/transfers"));
        assert!(!transfer.allows_http("POST", "/api/transfers/record-id/complete"));
    }
    #[test]
    fn desktop_view_can_start_and_stop_but_cannot_send_input() {
        let view = Capabilities {
            desktop_view: true,
            ..Capabilities::observer()
        };
        assert!(view.allows_http("POST", "/api/desktop/sessions"));
        assert!(view.allows_http("DELETE", "/api/desktop/sessions/session-id"));
        assert!(!view.allows_http("POST", "/api/desktop/sessions/session-id/input"));
    }
    #[test]
    fn preview_inspection_reads_keep_operator_access_without_exposing_cookie_storage_to_observers()
    {
        for action in ["cookies", "proxy-logs", "storage", "process-logs"] {
            let path = format!("/api/preview/3000/{action}");
            assert!(Capabilities::operator().allows_http("GET", &path), "{path}");
            assert!(
                !Capabilities::observer().allows_http("GET", &path),
                "{path}"
            );
        }
    }
    #[test]
    fn observer_can_read_history_but_cannot_execute_or_modify() {
        let observer = Capabilities::default();
        for path in [
            "/api/state",
            "/api/terminal",
            "/api/terminal/test/history",
            "/api/files/list",
            "/api/workspace/git/diff",
            "/api/structured/sessions/test",
        ] {
            assert!(observer.allows_http("GET", path), "{path}");
        }
        for (method, path) in [
            ("POST", "/api/terminal"),
            ("POST", "/api/terminal/test/input"),
            ("GET", "/api/preview/3000/evaluate"),
            ("POST", "/api/preview/3000/evaluate"),
            ("POST", "/api/workspace/rewind/test/apply"),
            ("GET", "/api/vault"),
            ("GET", "/api/files/download"),
            ("GET", "/api/future-execute"),
        ] {
            assert!(!observer.allows_http(method, path), "{method} {path}");
        }
        assert!(!observer.allows_terminal_message("input"));
        assert!(!observer.allows_structured_message("approve"));
    }
    #[test]
    fn operator_requires_explicit_desktop_and_tunnel_grants() {
        let operator = Capabilities::operator();
        for (method, path) in [
            ("POST", "/api/terminal"),
            ("POST", "/api/files/upload"),
            ("GET", "/api/files/download"),
            ("POST", "/api/workspace/tasks"),
        ] {
            assert!(operator.allows_http(method, path), "{path}");
        }
        for path in [
            "/api/desktop/frame",
            "/api/tunnels",
            "/api/vault",
            "/api/system/rebuild",
            "/api/environments",
        ] {
            assert!(!operator.allows_http("GET", path), "{path}");
        }
        assert!(operator.allows_terminal_message("resize"));
        assert!(!operator.allows_terminal_message("unknown"));
    }
    #[test]
    fn writes_need_all_relevant_capabilities() {
        let transfer = Capabilities {
            transfer: true,
            ..Capabilities::default()
        };
        assert!(transfer.allows_http("GET", "/api/files/download"));
        assert!(!transfer.allows_http("POST", "/api/files/upload"));
        let files = Capabilities {
            file_write: true,
            ..Capabilities::default()
        };
        assert!(files.allows_http("POST", "/api/files/mkdir"));
        assert!(!files.allows_http("POST", "/api/files/upload"));
        for path in [
            "/api/files/../vault",
            "/api/files/%2e%2e/vault",
            "/api/files//list",
            "/api/files/list\\x",
        ] {
            assert!(!Capabilities::operator().allows_http("GET", path));
        }
    }
}
