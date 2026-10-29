use super::*;
use serde_json::json;
use std::collections::VecDeque;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::{oneshot, watch};

const PACKET_LIMIT: usize = 1_048_576;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct CodexStructuredProvider;

impl StructuredProvider for CodexStructuredProvider {
    fn provider_id(&self) -> &'static str {
        "codex"
    }

    fn spawn(&self, options: StructuredSpawnOptions) -> Result<SpawnedStructuredProcess, String> {
        let command = crate::agent_runtime::native_command("codex")
            .ok_or("Codex is not installed on this computer. Install Codex, run codex login in a terminal, then try again.")?;
        spawn_command(command, options)
    }
}

enum Control {
    Approval {
        id: String,
        approved: bool,
        answers: Option<Value>,
        for_session: bool,
        #[cfg(unix)]
        paired: Option<Arc<super::PairedDecisionContext>>,
        reply: oneshot::Sender<Result<DecisionReceipt, String>>,
    },
}

struct Controller {
    controls: mpsc::Sender<Control>,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    cleanup: Arc<Cleanup>,
}

struct Cleanup {
    tree: crate::process_tree::ProcessTree,
    child: Mutex<Child>,
    blocked: AtomicBool,
    browser: Mutex<Option<crate::workspace_browser::AgentBrowserConnection>>,
    #[cfg(unix)]
    uncertain_guard: Mutex<Option<Arc<super::PairedDecisionContext>>>,
}

impl Cleanup {
    async fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().await;
        let stopped = self.tree.stop(Duration::from_millis(500)).await;
        let reaped = tokio::time::timeout(Duration::from_secs(2), self.tree.wait(&mut child)).await;
        let failed = stopped.is_err() || !matches!(reaped, Ok(Ok(_)));
        self.blocked.store(failed, Ordering::SeqCst);
        if failed {
            Err("Codex process cleanup could not be confirmed; retry Stop before continuing".into())
        } else {
            self.browser.lock().await.take();
            #[cfg(unix)]
            self.uncertain_guard.lock().await.take();
            Ok(())
        }
    }
}

impl Controller {
    async fn decide(
        &self,
        id: &str,
        approved: bool,
        answers: Option<Value>,
        for_session: bool,
        #[cfg(unix)] paired: Option<Arc<super::PairedDecisionContext>>,
    ) -> Result<DecisionReceipt, String> {
        let (reply, receive) = oneshot::channel();
        self.controls
            .send(Control::Approval {
                id: id.into(),
                approved,
                answers,
                for_session,
                #[cfg(unix)]
                paired,
                reply,
            })
            .await
            .map_err(|_| "This Codex action is no longer pending")?;
        tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .map_err(|_| "Codex has not confirmed the decision; retry the same action")?
            .map_err(|_| "Codex connection closed before confirming the decision")?
    }
}

#[async_trait]
impl StructuredProcessController for Controller {
    fn is_blocked(&self) -> bool {
        self.cleanup.blocked.load(Ordering::SeqCst)
    }
    async fn send_input(&self, _text: &str) -> Result<(), String> {
        Err("Codex is working. Use Stop before sending another message.".into())
    }
    async fn send_approval(&self, _approved: bool) -> Result<(), String> {
        Err("Codex approval requires the exact approvalId".into())
    }
    async fn send_bound_approval(
        &self,
        id: &str,
        approved: bool,
    ) -> Result<DecisionReceipt, String> {
        self.decide(
            id,
            approved,
            None,
            false,
            #[cfg(unix)]
            None,
        )
        .await
    }
    async fn send_bound_answers(
        &self,
        id: &str,
        answers: Value,
    ) -> Result<DecisionReceipt, String> {
        self.decide(
            id,
            true,
            Some(answers),
            false,
            #[cfg(unix)]
            None,
        )
        .await
    }
    async fn send_bound_session_approval(&self, id: &str) -> Result<DecisionReceipt, String> {
        self.decide(
            id,
            true,
            None,
            true,
            #[cfg(unix)]
            None,
        )
        .await
    }
    #[cfg(unix)]
    async fn send_paired_decision(
        &self,
        id: Option<&str>,
        approved: bool,
        answers: Option<Value>,
        for_session: bool,
        context: Arc<super::PairedDecisionContext>,
    ) -> Result<DecisionReceipt, String> {
        let id = id.ok_or("Codex approval requires the exact approvalId")?;
        context.check()?;
        self.decide(id, approved, answers, for_session, Some(context))
            .await
    }
    async fn interrupt(&self) -> Result<(), String> {
        self.kill().await
    }
    async fn kill(&self) -> Result<(), String> {
        self.cancel.send_replace(true);
        let mut done = self.done.clone();
        tokio::time::timeout(Duration::from_secs(8), async {
            while !*done.borrow_and_update() {
                done.changed()
                    .await
                    .map_err(|_| "Codex cleanup connection closed")?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "Codex cleanup is still running; retry Stop")??;
        self.cleanup.stop().await
    }
}

fn spawn_command(
    command: Command,
    options: StructuredSpawnOptions,
) -> Result<SpawnedStructuredProcess, String> {
    spawn_command_inner(
        command,
        options,
        #[cfg(test)]
        None,
    )
}

fn spawn_command_inner(
    mut command: Command,
    options: StructuredSpawnOptions,
    #[cfg(test)] wrap_stdin: Option<
        Box<
            dyn FnOnce(tokio::process::ChildStdin) -> Box<dyn tokio::io::AsyncWrite + Send + Unpin>
                + Send,
        >,
    >,
) -> Result<SpawnedStructuredProcess, String> {
    if options.prompt.trim().is_empty()
        || options.prompt.chars().count() > 50_000
        || options.prompt.contains('\0')
    {
        return Err("Codex prompt must contain 1–50000 characters without NUL".into());
    }
    if options
        .model
        .as_deref()
        .is_some_and(|m| m.len() > 200 || m.chars().any(char::is_control))
    {
        return Err("Invalid Codex model".into());
    }
    if options
        .reasoning
        .as_deref()
        .is_some_and(|r| !["low", "medium", "high", "xhigh", "max", "ultra"].contains(&r))
    {
        return Err("Unsupported Codex reasoning setting".into());
    }
    if options
        .service_tier
        .as_deref()
        .is_some_and(|tier| !matches!(tier, "default" | "fast" | "ultrafast"))
    {
        return Err("Unsupported Codex speed setting".into());
    }
    if matches!(options.service_tier.as_deref(), Some("fast" | "ultrafast")) {
        command.args(["-c", "features.fast_mode=true"]);
    }
    command
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(&options.cwd)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| {
        format!(
            "Could not start local Codex: {e}. Open Codex in a terminal to check its installation."
        )
    })?;
    #[cfg(unix)]
    let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child)
        .map_err(|e| format!("Could not contain the Codex process: {e}"))?;
    #[cfg(not(unix))]
    let tree = crate::process_tree::ProcessTree::attach(&child)
        .map_err(|e| format!("Could not contain the Codex process: {e}"))?;
    let stdin = child.stdin.take().ok_or("Codex stdin is unavailable")?;
    #[cfg(test)]
    let stdin: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = match wrap_stdin {
        Some(wrap) => wrap(stdin),
        None => Box::new(stdin),
    };
    #[cfg(not(test))]
    let stdin: Box<dyn tokio::io::AsyncWrite + Send + Unpin> = Box::new(stdin);
    let stdout = child.stdout.take().ok_or("Codex stdout is unavailable")?;
    let (packets, packet_rx) = mpsc::channel(8);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let packet = read_packet(&mut reader).await;
            let failed = packet.is_err();
            if packets.send(packet).await.is_err() || failed {
                break;
            }
        }
    });
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
    let (events, receiver) = mpsc::unbounded_channel();
    let (controls, control_rx) = mpsc::channel(16);
    let (cancel, cancel_rx) = watch::channel(false);
    let (done, done_rx) = watch::channel(false);
    let cleanup = Arc::new(Cleanup {
        tree,
        child: Mutex::new(child),
        blocked: AtomicBool::new(false),
        browser: Mutex::new(options.browser.clone()),
        #[cfg(unix)]
        uncertain_guard: Mutex::new(None),
    });
    let observed = cleanup.clone();
    let mut exit_watch_done = done_rx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                changed = exit_watch_done.changed() => {
                    if changed.is_err() || *exit_watch_done.borrow_and_update() {
                        return;
                    }
                    continue;
                }
            }
            let mut child = observed.child.lock().await;
            if !matches!(observed.tree.try_wait(&mut child), Ok(None)) {
                drop(child);
                let _ = observed.stop().await;
                return;
            }
        }
    });
    let controller = Arc::new(Controller {
        controls,
        cancel,
        done: done_rx,
        cleanup: cleanup.clone(),
    });
    tokio::spawn(async move {
        let turn_id = options
            .turn_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut connection = Connection {
            stdin,
            packets: packet_rx,
            events: events.clone(),
            controls: control_rx,
            cancel: cancel_rx,
            options,
            turn_id: turn_id.clone(),
            thread_id: String::new(),
            native_turn_id: None,
            emitted_bytes: AtomicUsize::new(0),
            pending: HashMap::new(),
            approval_order: VecDeque::new(),
            decisions: HashMap::new(),
            approval_items: HashMap::new(),
            uncertain_approval: None,
            #[cfg(unix)]
            uncertain_paired: None,
        };
        let result = connection.run().await;
        let uncertain_approval = connection.uncertain_approval.clone();
        #[cfg(unix)]
        if let Some(context) = connection.uncertain_paired.take() {
            *cleanup.uncertain_guard.lock().await = Some(context);
        }
        let status = match &result {
            Ok(status) => status.as_str(),
            Err(_) if *connection.cancel.borrow() => "interrupted",
            Err(_) => "failed",
        }
        .to_owned();
        if let Err(message) = result {
            if uncertain_approval.is_some() || status != "interrupted" {
                let _ = events.send(StructuredSessionEvent::Error {
                    ts: now_ts(),
                    seq: 0,
                    message,
                    code: Some(
                        uncertain_approval
                            .as_ref()
                            .map(|id| format!("codex_approval_uncertain:{id}"))
                            .unwrap_or_else(|| "codex_runtime".into()),
                    ),
                });
            }
        }
        if let Err(message) = cleanup.stop().await {
            let _ = events.send(StructuredSessionEvent::Error {
                ts: now_ts(),
                seq: 0,
                message,
                code: Some("codex_cleanup_pending".into()),
            });
        }
        for pending in connection.pending.into_values() {
            if uncertain_approval.as_deref() == Some(pending.approval_id.as_str()) {
                continue;
            }
            let _ = events.send(StructuredSessionEvent::ApprovalResolved {
                ts: now_ts(),
                seq: 0,
                approval_id: pending.approval_id,
                turn_id: turn_id.clone(),
                approved: false,
                reason: Some("Codex turn ended".into()),
            });
        }
        let _ = events.send(StructuredSessionEvent::TurnCompleted {
            ts: now_ts(),
            seq: 0,
            turn_id,
            status: status.clone(),
        });
        let _ = events.send(StructuredSessionEvent::SessionEnded {
            ts: now_ts(),
            seq: 0,
            session_id: connection.thread_id,
            reason: status,
        });
        done.send_replace(true);
    });
    Ok(SpawnedStructuredProcess {
        controller,
        events: receiver,
    })
}

struct Pending {
    approval_id: String,
    rpc_id: Value,
    method: String,
    params: Value,
}

enum ApprovalWriteFailure {
    NotStarted(String),
    Uncertain,
}

struct Connection {
    stdin: Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
    packets: mpsc::Receiver<Result<Value, String>>,
    events: mpsc::UnboundedSender<StructuredSessionEvent>,
    controls: mpsc::Receiver<Control>,
    cancel: watch::Receiver<bool>,
    options: StructuredSpawnOptions,
    turn_id: String,
    thread_id: String,
    native_turn_id: Option<String>,
    emitted_bytes: AtomicUsize,
    pending: HashMap<String, Pending>,
    approval_order: VecDeque<String>,
    decisions: HashMap<String, bool>,
    approval_items: HashMap<String, Value>,
    uncertain_approval: Option<String>,
    #[cfg(unix)]
    uncertain_paired: Option<Arc<super::PairedDecisionContext>>,
}

impl Connection {
    async fn write(&mut self, packet: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(3), async {
            self.stdin.write_all(&bytes).await?;
            self.stdin.flush().await
        })
        .await
        .map_err(|_| "Codex stopped accepting requests")?
        .map_err(|_| "Local Codex connection closed".to_owned())
    }
    async fn write_approval(
        &mut self,
        packet: Value,
        expires: Option<i64>,
    ) -> Result<(), ApprovalWriteFailure> {
        let mut bytes = serde_json::to_vec(&packet)
            .map_err(|error| ApprovalWriteFailure::NotStarted(error.to_string()))?;
        bytes.push(b'\n');
        let timeout = if let Some(expires) = expires {
            let remaining = expires.saturating_sub(crate::v4_agent::interaction::now_ms());
            if remaining <= 0 {
                return Err(ApprovalWriteFailure::NotStarted(
                    "Paired grant expired before Codex approval".into(),
                ));
            }
            Duration::from_millis(remaining as u64).min(Duration::from_secs(3))
        } else {
            Duration::from_secs(3)
        };
        let first = tokio::time::timeout(timeout, self.stdin.write(&bytes))
            .await
            .map_err(|_| ApprovalWriteFailure::Uncertain)?
            .map_err(|_| ApprovalWriteFailure::Uncertain)?;
        if first == 0 {
            return Err(ApprovalWriteFailure::Uncertain);
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            self.stdin.write_all(&bytes[first..]).await?;
            self.stdin.flush().await
        })
        .await
        .map_err(|_| ApprovalWriteFailure::Uncertain)?
        .map_err(|_| ApprovalWriteFailure::Uncertain)
    }
    fn emit(&self, event: StructuredSessionEvent) -> Result<(), String> {
        let size = serde_json::to_vec(&event).map_err(|e| e.to_string())?.len();
        if self
            .emitted_bytes
            .fetch_add(size, Ordering::SeqCst)
            .saturating_add(size)
            > 8 * 1024 * 1024
        {
            return Err("Codex output reached this turn's saved-output limit; this turn was stopped to preserve the conversation".into());
        }
        self.events
            .send(event)
            .map_err(|_| "Conversation closed".into())
    }
    async fn run(&mut self) -> Result<String, String> {
        self.write(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"terminal_v4","title":"Terminal V4","version":env!("CARGO_PKG_VERSION")}}})).await?;
        let mut phase = 1;
        let mut deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
        let mut stopping = false;
        loop {
            let mut packet = tokio::select! {
                biased;
                _ = self.cancel.changed(), if !stopping => {
                    if let Some(turn) = &self.native_turn_id {
                        self.write(json!({"id":90,"method":"turn/interrupt","params":{"threadId":self.thread_id,"turnId":turn}})).await?;
                        stopping = true;
                        deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                        continue;
                    }
                    return Ok("interrupted".into());
                }
                _ = self.events.closed() => { return Ok("interrupted".into()); }
                _ = tokio::time::sleep_until(deadline), if phase < 5 || stopping => {
                    if stopping { return Ok("interrupted".into()); }
                    return Err("Local Codex did not finish connecting. Run codex in a terminal to check sign-in and configuration, then retry.".into());
                }
                control = self.controls.recv() => {
                    match control {
                        Some(Control::Approval { id, approved, answers, for_session, #[cfg(unix)] paired, reply }) => {
                            let result = self.approve(&id, approved, answers.as_ref(), for_session, #[cfg(unix)] paired.as_deref()).await;
                            if self.uncertain_approval.is_some() {
                                #[cfg(unix)] { self.uncertain_paired = paired; }
                                let _ = reply.send(result);
                                return Err("Codex approval delivery is uncertain; the connection was stopped. Check the conversation before retrying".into());
                            }
                            let _ = reply.send(result);
                        }
                        None => return Ok("interrupted".into()),
                    }
                    continue;
                }
                packet = self.packets.recv() => packet.ok_or("Local Codex output closed")??,
            };
            if let Some(browser) = &self.options.browser {
                redact_browser_token(&mut packet, &browser.token);
            }
            if packet.get("method").is_some() {
                if packet.get("id").is_some() {
                    self.request(&packet).await?;
                } else {
                    if let Some(thread) = packet["params"]["threadId"].as_str() {
                        if !self.thread_id.is_empty() && thread != self.thread_id {
                            continue;
                        }
                    }
                    if packet["method"] == "turn/started" {
                        self.native_turn_id =
                            packet["params"]["turn"]["id"].as_str().map(str::to_owned);
                    }
                    if let (Some(expected), Some(actual)) =
                        (&self.native_turn_id, packet["params"]["turnId"].as_str())
                    {
                        if expected != actual {
                            continue;
                        }
                    }
                    let item = &packet["params"]["item"];
                    if let Some(id) = item["id"].as_str() {
                        if packet["method"] == "item/completed" {
                            self.approval_items.remove(id);
                        } else if packet["method"] == "item/started"
                            && matches!(
                                item["type"].as_str(),
                                Some("fileChange" | "commandExecution" | "mcpToolCall")
                            )
                        {
                            let details = json!({"command":item["command"],"cwd":item["cwd"],"changes":item["changes"],"server":item["server"],"tool":item["tool"],"arguments":item["arguments"]});
                            self.approval_items.insert(id.into(), details);
                            if self.approval_items.len() > 16
                                || self
                                    .approval_items
                                    .values()
                                    .map(|item| item.to_string().len())
                                    .sum::<usize>()
                                    > 2 * PACKET_LIMIT
                            {
                                return Err("Codex proposed too many simultaneous actions; this turn was stopped".into());
                            }
                        }
                    }
                    if packet["method"] == "serverRequest/resolved" {
                        let native_id = &packet["params"]["requestId"];
                        let id = self
                            .pending
                            .iter()
                            .find(|(_, p)| &p.rpc_id == native_id)
                            .map(|(id, _)| id.clone());
                        if let Some(pending) = id.and_then(|id| self.pending.remove(&id)) {
                            let visible = self.approval_order.front() == Some(&pending.approval_id);
                            self.approval_order.retain(|id| id != &pending.approval_id);
                            self.emit(StructuredSessionEvent::ApprovalResolved {
                                ts: now_ts(),
                                seq: 0,
                                approval_id: pending.approval_id,
                                turn_id: self.turn_id.clone(),
                                approved: false,
                                reason: Some("Codex is no longer waiting for this action".into()),
                            })?;
                            if visible {
                                self.show_approval()?;
                            }
                        }
                    }
                    if packet["method"] == "turn/completed" {
                        if self
                            .native_turn_id
                            .as_deref()
                            .is_some_and(|id| packet["params"]["turn"]["id"].as_str() != Some(id))
                        {
                            continue;
                        }
                        if let Some(message) = packet["params"]["turn"]["error"]["message"].as_str()
                        {
                            self.emit(StructuredSessionEvent::Error {
                                ts: now_ts(),
                                seq: 0,
                                message: message.into(),
                                code: Some("codex_turn_failed".into()),
                            })?;
                        }
                        if stopping {
                            return Ok("interrupted".into());
                        }
                        return match packet["params"]["turn"]["status"].as_str() {
                            Some("completed") => Ok("completed".into()),
                            Some("interrupted") => Ok("interrupted".into()),
                            _ => Ok("failed".into()),
                        };
                    }
                    for event in map_notification(&packet, &self.turn_id) {
                        self.emit(event)?;
                    }
                }
                continue;
            }
            if packet["id"].as_u64() != Some(phase) {
                continue;
            }
            if let Some(error) = packet.get("error") {
                let detail = error["message"]
                    .as_str()
                    .unwrap_or("Unsupported Codex response");
                return Err(format!("Codex could not continue: {detail}. Check Codex in a terminal before retrying. The existing conversation was preserved."));
            }
            match phase {
                1 => {
                    self.write(json!({"method":"initialized"})).await?;
                    self.write(
                        json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
                    )
                    .await?;
                }
                2 => {
                    if packet["result"]["requiresOpenaiAuth"] == true
                        && packet["result"]["account"].is_null()
                    {
                        return Err("Codex is not signed in on this computer. Run codex login in a terminal, then send your message again.".into());
                    }
                    let (sandbox, approval_policy) =
                        codex_access_policy(self.options.access_mode.as_deref(), self.options.plan);
                    let mut params = json!({"cwd":self.options.cwd,"sandbox":sandbox,"approvalPolicy":approval_policy});
                    if let Some(model) = self.options.model.as_ref().filter(|m| !m.is_empty()) {
                        params["model"] = json!(model);
                    }
                    if let Some(reasoning) = &self.options.reasoning {
                        params["config"] = json!({"model_reasoning_effort":reasoning});
                    }
                    if let Some(browser) = &self.options.browser {
                        if params["config"].is_null() {
                            params["config"] = json!({});
                        }
                        // Only the leased app transport skips Codex's duplicate gate;
                        // the parent broker still reviews each exact browser action.
                        // Dotted overrides retain the user's other MCP server tables.
                        params["config"]["mcp_servers.terminal_v4_browser"] = json!({
                            "url": browser.url,
                            "http_headers": {"Authorization": format!("Bearer {}", browser.token)},
                            "default_tools_approval_mode": "approve"
                        });
                        params["approvalsReviewer"] = json!("user");
                        params["developerInstructions"] = json!(SHARED_BROWSER_INSTRUCTIONS);
                    }
                    if self.options.plan {
                        let instructions = params["developerInstructions"]
                            .as_str()
                            .map(|existing| format!("{existing}\n\n{PLAN_INSTRUCTIONS}"))
                            .unwrap_or_else(|| PLAN_INSTRUCTIONS.to_owned());
                        params["developerInstructions"] = json!(instructions);
                    }
                    params["serviceTier"] = json!(self.options.service_tier);
                    let method = if let Some(id) = &self.options.session_id {
                        params["threadId"] = json!(id);
                        params["excludeTurns"] = json!(true);
                        "thread/resume"
                    } else {
                        "thread/start"
                    };
                    self.write(json!({"id":3,"method":method,"params":params}))
                        .await?;
                }
                3 => {
                    self.thread_id = packet["result"]["thread"]["id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Codex did not return a conversation identity")?
                        .into();
                    if self
                        .options
                        .session_id
                        .as_ref()
                        .is_some_and(|id| id != &self.thread_id)
                    {
                        return Err("Codex returned a different conversation while resuming".into());
                    }
                    self.emit(StructuredSessionEvent::SessionStarted {
                        ts: now_ts(),
                        seq: 0,
                        session_id: self.thread_id.clone(),
                        provider: "codex".into(),
                    })?;
                    self.write(json!({"id":4,"method":"turn/start","params":{"threadId":self.thread_id,"input":[{"type":"text","text":self.options.prompt}],"effort":self.options.reasoning,"summary":"detailed","serviceTier":self.options.service_tier}})).await?;
                }
                4 => {
                    self.native_turn_id =
                        packet["result"]["turn"]["id"].as_str().map(str::to_owned);
                    self.emit(StructuredSessionEvent::TurnStarted {
                        ts: now_ts(),
                        seq: 0,
                        turn_id: self.turn_id.clone(),
                    })?;
                }
                _ => {}
            }
            phase += 1;
            deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
        }
    }
    async fn request(&mut self, packet: &Value) -> Result<(), String> {
        let method = packet["method"].as_str().unwrap_or_default();
        let mut params = packet["params"].clone();
        let browser_request = matches!(
            method,
            "item/tool/requestUserInput" | "mcpServer/elicitation/request"
        );
        if browser_request {
            let browser = self
                .options
                .browser
                .is_some()
                .then(|| browser_approval(method, &params, &self.approval_items))
                .flatten();
            match browser {
                Some(browser) => {
                    params["itemId"] = browser["itemId"].clone();
                    params["browserApproval"] = browser;
                }
                // Questions for the user are shown in the conversation and answered there.
                None if method == "item/tool/requestUserInput"
                    && params["questions"]
                        .as_array()
                        .is_some_and(|questions| !questions.is_empty() && questions.len() <= 8) => {
                }
                None => {
                    let result = if method == "mcpServer/elicitation/request" {
                        json!({"action":"decline","content":null})
                    } else {
                        json!({"answers":{}})
                    };
                    self.write(json!({"id":packet["id"],"result":result}))
                        .await?;
                    return Ok(());
                }
            }
        }
        if ![
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
        ]
        .contains(&method)
            && !browser_request
        {
            self.write(json!({"id":packet["id"],"error":{"code":-32601,"message":"This client does not support this request. Ask the user in the conversation instead."}})).await?;
            return Ok(());
        }
        if packet["params"]["threadId"].as_str() != Some(&self.thread_id)
            || self
                .native_turn_id
                .as_deref()
                .is_some_and(|id| packet["params"]["turnId"].as_str() != Some(id))
            || self.pending.len() >= 16
            || self.pending.values().any(|p| p.rpc_id == packet["id"])
        {
            return Err("Codex sent an invalid or excessive approval request".into());
        }
        let id = Uuid::new_v4().to_string();
        if let Some(item) = params["itemId"]
            .as_str()
            .and_then(|id| self.approval_items.get(id))
        {
            for field in ["command", "cwd", "changes"] {
                if params[field].is_null() && !item[field].is_null() {
                    params[field] = item[field].clone();
                }
            }
        }
        if method.contains("fileChange")
            && !params["changes"]
                .as_array()
                .is_some_and(|changes| !changes.is_empty())
        {
            return Err("Codex did not provide the proposed file changes for review. This turn was stopped; check the action in a Codex terminal.".into());
        }
        self.pending.insert(
            id.clone(),
            Pending {
                approval_id: id.clone(),
                rpc_id: packet["id"].clone(),
                method: method.into(),
                params,
            },
        );
        self.approval_order.push_back(id);
        if self.approval_order.len() == 1 {
            self.show_approval()?;
        }
        Ok(())
    }

    fn show_approval(&self) -> Result<(), String> {
        let Some(pending) = self
            .approval_order
            .front()
            .and_then(|id| self.pending.get(id))
        else {
            return Ok(());
        };
        let method = pending.method.as_str();
        let params = &pending.params;
        let browser = &params["browserApproval"];
        let question = method == "item/tool/requestUserInput" && browser.is_null();
        let mut visible_input = if !browser.is_null() {
            browser["input"].clone()
        } else if question {
            json!({"questions":params["questions"]})
        } else if method.contains("commandExecution") {
            json!({"command":params["command"],"directory":params["cwd"],"network":params["networkApprovalContext"]})
        } else if method.contains("fileChange") {
            json!({"changes":params["changes"],"writeAccess":params["grantRoot"]})
        } else {
            json!({"permissions":params["permissions"]})
        };
        if let Some(fields) = visible_input.as_object_mut() {
            fields.retain(|_, value| !value.is_null());
        }
        self.emit(StructuredSessionEvent::ApprovalRequired {
            ts: now_ts(),
            seq: 0,
            approval_id: Some(pending.approval_id.clone()),
            turn_id: Some(self.turn_id.clone()),
            tool_call_id: params["itemId"].as_str().map(str::to_owned),
            expires_at: None,
            tool_name: if let Some(tool) = browser["tool"].as_str() {
                tool
            } else if question {
                "ask_user"
            } else if method.contains("commandExecution") {
                "run_command"
            } else if method.contains("fileChange") {
                "edit_files"
            } else {
                "permissions"
            }
            .into(),
            tool_input: visible_input,
            description: params["reason"]
                .as_str()
                .or(params["message"].as_str())
                .or(browser["question"].as_str())
                .unwrap_or(if question {
                    "Codex has a question for you."
                } else {
                    "Codex needs your permission for this action."
                })
                .into(),
        })?;
        Ok(())
    }
    async fn approve(
        &mut self,
        id: &str,
        approved: bool,
        answers: Option<&Value>,
        for_session: bool,
        #[cfg(unix)] paired: Option<&super::PairedDecisionContext>,
    ) -> Result<DecisionReceipt, String> {
        if self.uncertain_approval.is_some() {
            return Err(
                "Codex approval delivery is uncertain; check the conversation before retrying"
                    .into(),
            );
        }
        if let Some(previous) = self.decisions.get(id) {
            if *previous != approved {
                return Err("This Codex action already has a different decision".into());
            }
            return Ok(DecisionReceipt {
                status: "already_decided".into(),
                approval_id: id.into(),
                approved,
            });
        }
        if self.decisions.len() >= 256 {
            return Err("Codex approval storage is full; stop this turn before continuing".into());
        }
        if self.approval_order.front().map(String::as_str) != Some(id) {
            return Err("This Codex action is not the displayed approval".into());
        }
        let pending = self
            .pending
            .get(id)
            .ok_or("This exact Codex action is no longer pending")?;
        let result = if pending.method == "mcpServer/elicitation/request" {
            json!({"action":if approved {"accept"} else {"decline"},"content":null})
        } else if pending.method == "item/tool/requestUserInput"
            && pending.params["browserApproval"].is_null()
        {
            if approved {
                question_answers(&pending.params["questions"], answers)?
            } else {
                json!({"answers":{}})
            }
        } else if pending.method == "item/tool/requestUserInput" {
            let question = pending.params["browserApproval"]["questionId"]
                .as_str()
                .ok_or("Browser approval question identity is missing")?;
            json!({"answers":{question:{"answers":[if approved {"Allow"} else {"Cancel"}]}}})
        } else if pending.method == "item/permissions/requestApproval" {
            json!({"permissions":if approved {pending.params["permissions"].clone()} else {json!({})},"scope":"turn"})
        } else {
            {
                let decision = match (approved, for_session) {
                    (true, true) => "acceptForSession",
                    (true, false) => "accept",
                    (false, _) => "decline",
                };
                json!({ "decision": decision })
            }
        };
        let packet = json!({"id":pending.rpc_id,"result":result});
        #[cfg(unix)]
        let expires = paired.map(|authority| authority.check()).transpose()?;
        #[cfg(not(unix))]
        let expires = None;
        if let Err(error) = self.write_approval(packet, expires).await {
            return match error {
                ApprovalWriteFailure::NotStarted(message) => Err(message),
                ApprovalWriteFailure::Uncertain => {
                    self.uncertain_approval = Some(id.into());
                    Err("Codex approval delivery may be partial; the connection is stopping. Check the conversation before retrying".into())
                }
            };
        }
        self.pending.remove(id);
        self.approval_order.pop_front();
        self.decisions.insert(id.into(), approved);
        self.emit(StructuredSessionEvent::ApprovalResolved {
            ts: now_ts(),
            seq: 0,
            approval_id: id.into(),
            turn_id: self.turn_id.clone(),
            approved,
            reason: None,
        })?;
        self.show_approval()?;
        Ok(DecisionReceipt {
            status: "accepted".into(),
            approval_id: id.into(),
            approved,
        })
    }
}

fn browser_approval(method: &str, params: &Value, items: &HashMap<String, Value>) -> Option<Value> {
    let (id, item, question) = if method == "item/tool/requestUserInput" {
        let id = params["itemId"].as_str()?;
        let questions = params["questions"].as_array()?;
        if questions.len() != 1 {
            return None;
        }
        let question = &questions[0];
        if question["id"] != format!("mcp_tool_call_approval_{id}")
            || question["isOther"] == true
            || question["isSecret"] == true
        {
            return None;
        }
        let options = question["options"].as_array()?;
        if !["Allow", "Cancel"]
            .iter()
            .all(|label| options.iter().any(|option| option["label"] == *label))
        {
            return None;
        }
        (id, items.get(id)?, Some(question))
    } else {
        if params["serverName"] != "terminal_v4_browser"
            || params["mode"] != "form"
            || params["_meta"]["codex_approval_kind"] != "mcp_tool_call"
            || !params["requestedSchema"]["properties"]
                .as_object()?
                .is_empty()
            || params["requestedSchema"]["required"]
                .as_array()
                .is_some_and(|fields| !fields.is_empty())
            || params["_meta"]["tool_params"].is_null()
        {
            return None;
        }
        let mut matches = items.iter().filter(|(_, item)| {
            item["server"] == "terminal_v4_browser"
                && item["arguments"] == params["_meta"]["tool_params"]
        });
        let (id, item) = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        (id.as_str(), item, None)
    };
    if item["server"] != "terminal_v4_browser" {
        return None;
    }
    let tool = item["tool"].as_str()?;
    Some(
        json!({"itemId":id,"tool":format!("terminal_v4_browser.{tool}"),"input":item["arguments"],
        "questionId":question.map(|q| &q["id"]),"question":question.map(|q| &q["question"])}),
    )
}

async fn read_packet(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Value, String> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| "Could not read local Codex output")?;
        if buffer.is_empty() {
            return Err("Local Codex disconnected before completing the turn. The conversation was kept; check Codex in a terminal.".into());
        }
        let length = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        if bytes.len() + length > PACKET_LIMIT {
            return Err(
                "Codex output exceeded the supported message size; this turn was stopped".into(),
            );
        }
        bytes.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if bytes.last() == Some(&b'\n') {
            return serde_json::from_slice(&bytes)
                .map_err(|_| "Codex returned an invalid protocol message".into());
        }
    }
}

const MAX_PLAN_STEPS: usize = 50;

fn map_notification(packet: &Value, turn_id: &str) -> Vec<StructuredSessionEvent> {
    let params = &packet["params"];
    let turn = Some(turn_id.to_owned());
    let ts = now_ts();
    match packet["method"].as_str() {
        Some("item/commandExecution/outputDelta") => vec![StructuredSessionEvent::ToolOutput {
            ts,
            seq: 0,
            turn_id: turn,
            tool_name: "run_command".into(),
            tool_call_id: params["itemId"].as_str().map(str::to_owned),
            output: params["delta"].as_str().unwrap_or_default().into(),
            stream: None,
        }],
        Some("thread/tokenUsage/updated") => {
            let usage = &params["tokenUsage"];
            let total = &usage["total"];
            let last = &usage["last"];
            let count = |value: &Value, key: &str| value[key].as_u64().unwrap_or(0);
            vec![StructuredSessionEvent::ContextUsage {
                ts,
                seq: 0,
                turn_id: turn_id.to_owned(),
                usage: json!({
                    "inputTokens": count(total, "inputTokens"),
                    "outputTokens": count(total, "outputTokens"),
                    "cacheReadTokens": count(total, "cachedInputTokens"),
                    "contextTokens": count(last, "inputTokens") + count(last, "outputTokens"),
                    "contextWindow": usage["modelContextWindow"].as_u64(),
                    "costUsd": Value::Null,
                }),
            }]
        }
        Some("item/reasoning/summaryTextDelta") => vec![StructuredSessionEvent::MessageDelta {
            ts,
            seq: 0,
            turn_id: turn,
            message_id: params["itemId"].as_str().map(str::to_owned),
            role: "reasoning".into(),
            content: params["delta"].as_str().unwrap_or_default().into(),
        }],
        Some("item/reasoning/summaryPartAdded")
            if params["summaryIndex"]
                .as_u64()
                .is_some_and(|index| index > 0) =>
        {
            vec![StructuredSessionEvent::MessageDelta {
                ts,
                seq: 0,
                turn_id: turn,
                message_id: params["itemId"].as_str().map(str::to_owned),
                role: "reasoning".into(),
                content: "\n\n".into(),
            }]
        }
        Some("turn/plan/updated") => {
            let steps: Vec<Value> = params["plan"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|step| {
                    Some(json!({"step": step["step"].as_str()?, "status": step["status"].as_str().unwrap_or("pending")}))
                })
                .take(MAX_PLAN_STEPS)
                .collect();
            if steps.is_empty() {
                return vec![];
            }
            vec![StructuredSessionEvent::MessageCompleted {
                ts,
                seq: 0,
                turn_id: turn,
                message_id: Some(format!("plan-{turn_id}")),
                role: "plan".into(),
                content: json!({"explanation": params["explanation"].as_str(), "steps": steps})
                    .to_string(),
            }]
        }
        Some("item/agentMessage/delta") => vec![StructuredSessionEvent::MessageDelta {
            ts,
            seq: 0,
            turn_id: turn,
            message_id: params["itemId"].as_str().map(str::to_owned),
            role: "assistant".into(),
            content: params["delta"].as_str().unwrap_or_default().into(),
        }],
        Some("item/started" | "item/completed") => {
            let item = &params["item"];
            let id = item["id"].as_str().map(str::to_owned);
            let completed = packet["method"] == "item/completed";
            if item["type"] == "reasoning" {
                // Only the summary is meant for people; raw reasoning text stays private.
                let summary = item["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n\n");
                return if completed && !summary.trim().is_empty() {
                    vec![StructuredSessionEvent::MessageCompleted {
                        ts,
                        seq: 0,
                        turn_id: turn,
                        message_id: id,
                        role: "reasoning".into(),
                        content: summary,
                    }]
                } else {
                    vec![]
                };
            }
            if item["type"] == "agentMessage" {
                return vec![if completed {
                    StructuredSessionEvent::MessageCompleted {
                        ts,
                        seq: 0,
                        turn_id: turn,
                        message_id: id,
                        role: "assistant".into(),
                        content: item["text"].as_str().unwrap_or_default().into(),
                    }
                } else {
                    StructuredSessionEvent::MessageStarted {
                        ts,
                        seq: 0,
                        turn_id: turn,
                        message_id: id,
                        role: "assistant".into(),
                    }
                }];
            }
            let (name, input, output) = match item["type"].as_str() {
                Some("commandExecution") => (
                    "run_command".to_owned(),
                    json!({"command":item["command"],"cwd":item["cwd"]}),
                    item["aggregatedOutput"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                ),
                Some("fileChange") => (
                    "edit_files".to_owned(),
                    json!({"changes":item["changes"]}),
                    item["changes"].to_string(),
                ),
                Some("mcpToolCall") => (
                    format!(
                        "{}.{}",
                        item["server"].as_str().unwrap_or("mcp"),
                        item["tool"].as_str().unwrap_or("tool")
                    ),
                    item["arguments"].clone(),
                    item["result"]["content"]
                        .as_array()
                        .map(|blocks| {
                            blocks
                                .iter()
                                .filter_map(|b| b["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default(),
                ),
                Some("webSearch") => (
                    "web_search".to_owned(),
                    json!({"query":item["query"]}),
                    item["action"].to_string(),
                ),
                _ => return vec![],
            };
            vec![if completed {
                StructuredSessionEvent::ToolCompleted {
                    ts,
                    seq: 0,
                    turn_id: turn,
                    tool_call_id: id,
                    tool_name: name,
                    result: output,
                    is_error: item["status"] == "failed"
                        || item["status"] == "declined"
                        || item["exitCode"].as_i64().is_some_and(|c| c != 0),
                    content: None,
                }
            } else {
                StructuredSessionEvent::ToolStarted {
                    ts,
                    seq: 0,
                    turn_id: turn,
                    tool_call_id: id,
                    tool_name: name,
                    tool_input: input,
                }
            }]
        }
        Some("error") => vec![StructuredSessionEvent::Error {
            ts,
            seq: 0,
            message: params["error"]["message"]
                .as_str()
                .unwrap_or("Codex reported an error")
                .into(),
            code: Some("codex_provider".into()),
        }],
        _ => vec![],
    }
}

/// Validates the user's answers against Codex's questions and shapes the protocol reply.
fn question_answers(questions: &Value, answers: Option<&Value>) -> Result<Value, String> {
    let answers = answers
        .and_then(Value::as_object)
        .ok_or("Answer the question before sending")?;
    let known: Vec<&str> = questions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|question| question["id"].as_str())
        .collect();
    let mut reply = serde_json::Map::new();
    for (id, values) in answers {
        let values = values.as_array().ok_or("Each answer must be a list")?;
        let texts: Option<Vec<&str>> = values.iter().map(Value::as_str).collect();
        let texts = texts.ok_or("Answers must be text")?;
        if !known.contains(&id.as_str())
            || texts.is_empty()
            || texts.len() > 16
            || texts
                .iter()
                .any(|text| text.trim().is_empty() || text.len() > 4000)
        {
            return Err("Those answers do not match Codex's questions".into());
        }
        reply.insert(id.clone(), json!({"answers": texts}));
    }
    if reply.is_empty() {
        return Err("Answer the question before sending".into());
    }
    Ok(json!({"answers": reply}))
}

const PLAN_INSTRUCTIONS: &str = "Plan mode: investigate the request and reply with a concise, numbered implementation plan. Do not change files or run commands that modify anything.";

/// Codex sandbox and approval policy for a thread's access mode (auto-edit when unset); plans are read-only.
pub(super) fn codex_access_policy(
    access: Option<&str>,
    plan: bool,
) -> (&'static str, &'static str) {
    if plan {
        return ("read-only", "never");
    }
    match access {
        Some("supervised") => ("workspace-write", "untrusted"),
        Some("full") => ("danger-full-access", "never"),
        _ => ("workspace-write", "on-request"),
    }
}

#[cfg(test)]
mod tests;
