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
            ["api", "structured", "input-capabilities"] => read,
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
            ["api", "structured", "sessions", _, "attachments", ..] => false,
            ["api", "structured", "sessions", _, "input-operation" | "supervised-input"] => false,
            ["api", "structured", "start-requests"] => self.agent_execute && method == "POST",
            ["api", "structured", "start-requests", _] => self.agent_execute && read,
            ["api", "structured", "sessions", _, "context"]
            | ["api", "structured", "sessions", _, "approval-capability"]
            | ["api", "structured", "sessions", _, "requests", _]
            | ["api", "structured", "sessions", _, "queue", "operations", _] => {
                read && self.agent_execute
            }
            ["api", "structured", "sessions", _, "approval-claims", _, "review" | "reserve"] => {
                self.agent_execute && method == "POST"
            }
            ["api", "structured", "sessions", _, "private-output", "preview" | "approve"] => {
                self.agent_execute && method == "POST"
            }
            ["api", "structured", "sessions", _, "queue"] => {
                self.agent_execute && (read || method == "POST")
            }
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
            ["api", "workspace", "files", "search-content" | "read-content" | "list-directory"] => {
                read && self.transfer
            }
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
                            | [
                                "git",
                                "status" | "diff" | "branches" | "worktrees" | "checkpoints"
                            ]
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
            ["api", "preview", _, "evaluate" | "storage" | "screenshot" | "client-operation"] => {
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
    fn private_output_routes_require_agent_execution_and_exact_post_paths() {
        for action in ["preview", "approve"] {
            let path = format!("/api/structured/sessions/session/private-output/{action}");
            assert!(Capabilities::operator().allows_http("POST", &path));
            assert!(!Capabilities::observer().allows_http("POST", &path));
            assert!(!Capabilities::operator().allows_http("GET", &path));
            assert!(!Capabilities::operator().allows_http("POST", &format!("{path}/extra")));
        }
    }
    #[test]
    fn paired_input_capability_probe_is_read_only_and_supervised_routes_are_not_delegated() {
        for capability in [Capabilities::observer(), Capabilities::operator()] {
            assert!(capability.allows_http("GET", "/api/structured/input-capabilities"));
            assert!(capability.allows_http("HEAD", "/api/structured/input-capabilities"));
            for (method, path) in [
                ("POST", "/api/structured/input-capabilities"),
                ("GET", "/api/structured/input-capabilities/extra"),
                ("POST", "/api/structured/sessions/session/input-operation"),
                ("POST", "/api/structured/sessions/session/supervised-input"),
                ("GET", "/api/structured/input-watermark"),
                ("GET", "/api/structured/input-receipts"),
                (
                    "POST",
                    "/api/structured/input-receipts/session/request/review",
                ),
            ] {
                assert!(!capability.allows_http(method, path), "{method} {path}");
            }
        }
        assert!(
            Capabilities::operator().allows_http("POST", "/api/structured/sessions/session/input")
        );
        assert!(
            !Capabilities::observer().allows_http("POST", "/api/structured/sessions/session/input")
        );
    }
    #[test]
    fn ownership_reconciliation_is_not_available_via_remote_environment_proxy() {
        for capability in [Capabilities::observer(), Capabilities::operator()] {
            for (method, path) in [
                ("GET", "/api/structured/ownership"),
                ("POST", "/api/structured/ownership/reconcile"),
                ("GET", "/api/structured/owner-cleanup"),
                ("POST", "/api/structured/owner-cleanup/retry"),
                ("POST", "/api/structured/owner-cleanup/background-review"),
                ("GET", "/api/structured/owner-cleanup/delegation-children"),
                ("POST", "/api/structured/owner-cleanup/delegation-review"),
                (
                    "GET",
                    "/api/structured/owner-cleanup/delegation-review/operation",
                ),
            ] {
                assert!(!capability.allows_http(method, path), "{method} {path}");
            }
        }
    }
    #[test]
    fn start_request_routes_require_agent_execution_and_exact_methods() {
        let grant = Capabilities {
            agent_execute: true,
            ..Capabilities::observer()
        };
        let observer = Capabilities::observer();
        assert!(grant.allows_http("POST", "/api/structured/start-requests"));
        assert!(grant.allows_http("GET", "/api/structured/start-requests/id"));
        for (method, path) in [
            ("POST", "/api/structured/start-requests"),
            ("GET", "/api/structured/start-requests/id"),
        ] {
            assert!(!observer.allows_http(method, path));
        }
        for (method, path) in [
            ("GET", "/api/structured/start-requests"),
            ("POST", "/api/structured/start-requests/id"),
            ("DELETE", "/api/structured/start-requests/id"),
            ("GET", "/api/structured/start-requests/id/extra"),
        ] {
            assert!(!grant.allows_http(method, path));
        }
    }

    #[test]
    fn structured_recovery_reads_require_agent_execution_and_exact_routes() {
        let allowed = [
            "/api/structured/sessions/session/context",
            "/api/structured/sessions/session/queue",
            "/api/structured/sessions/session/requests/request",
            "/api/structured/sessions/session/queue/operations/operation",
        ];
        let grant = Capabilities {
            agent_execute: true,
            ..Capabilities::observer()
        };
        for path in allowed {
            for method in ["GET", "HEAD"] {
                assert!(Capabilities::operator().allows_http(method, path));
                assert!(grant.allows_http(method, path));
                assert!(!Capabilities::observer().allows_http(method, path));
                assert!(!Capabilities {
                    file_write: true,
                    transfer: true,
                    ..Capabilities::observer()
                }
                .allows_http(method, path));
            }
        }
        for path in [
            "/api/structured/sessions/session/requests/request",
            "/api/structured/sessions/session/context",
            "/api/structured/sessions/session/queue/operations/operation",
        ] {
            for method in ["POST", "PATCH", "PUT", "DELETE"] {
                assert!(!grant.allows_http(method, path));
            }
        }
        assert!(grant.allows_http("POST", "/api/structured/sessions/session/queue"));
        for path in [
            "/api/structured/sessions/session/requests/request/extra",
            "/api/structured/sessions/session/context/extra",
            "/api/structured/sessions/session/queue/operations/operation/extra",
            "/api/agent/connections",
            "/api/environments",
            "/api/vault",
        ] {
            assert!(!grant.allows_http("GET", path), "{path}");
        }
        assert!(grant.allows_http("POST", "/api/preview/4173/client-operation"));
        assert!(!Capabilities::observer().allows_http("POST", "/api/preview/4173/client-operation"));
    }
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
    fn branch_discovery_is_read_only_and_exact() {
        let observer = Capabilities::observer();
        assert!(observer.allows_http("GET", "/api/workspace/git/branches"));
        assert!(observer.allows_http("HEAD", "/api/workspace/git/branches"));
        assert!(!observer.allows_http("POST", "/api/workspace/git/branches"));
        assert!(!observer.allows_http("GET", "/api/workspace/git/branches/extra"));
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
            ("GET", "/api/workspace/files/search-content"),
            ("GET", "/api/workspace/files/read-content"),
            ("GET", "/api/workspace/files/list-directory"),
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
        assert!(transfer.allows_http("GET", "/api/workspace/files/search-content"));
        assert!(!transfer.allows_http("POST", "/api/workspace/files/search-content"));
        assert!(transfer.allows_http("GET", "/api/workspace/files/read-content"));
        assert!(!transfer.allows_http("POST", "/api/workspace/files/read-content"));
        assert!(transfer.allows_http("GET", "/api/workspace/files/list-directory"));
        assert!(!transfer.allows_http("POST", "/api/workspace/files/list-directory"));
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
