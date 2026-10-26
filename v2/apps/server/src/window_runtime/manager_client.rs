//! Private manager observations only. Core still owns every admission and grant.
//! One connection, no retry: a lost reply may follow a durable manager mutation.
use orkestr_runtime::containment::metadata::BrokerChildLocator;
use orkestr_v2_contracts::{ConversationId, EventId, ExecutionWindowLimits, MessageId, OwnerId};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Instant};
use tokio::net::UnixStream;
use uuid::Uuid;

#[path = "manager_client_wire.rs"]
mod wire;
use wire::*;

const MAX_FRAME: usize = 8192;
const INTEGER_LIMIT: u64 = 1 << 53;

pub use wire::ManagerError;
type Result<T> = std::result::Result<T, ManagerError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub window_id: Uuid,
    pub generation: u64,
}
pub struct Admission {
    pub request_id: String,
    pub window: Window,
    pub expected_generation: u64,
    pub input_message_id: MessageId,
    pub input_event_id: EventId,
    pub input_request_key: String,
    pub predecessor_window_id: Option<Uuid>,
    pub opened_at_ms: i64,
    pub work_deadline_ms: i64,
    pub expires_at_ms: i64,
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Active,
    Draining,
    Expired,
    Retired,
    Reconciliation,
}
#[derive(Debug, Clone, Copy, serde::Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutcome {
    Accepted,
    Stopped,
    /// Only from `reconcile`: Core's audited abandonment of unaccepted work.
    Abandoned,
    /// Only from `reconcile`: the window's open failed before any run of its own.
    Failed,
}
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Uncertainty {
    RuntimeRefused,
    AuthRevoked,
    CleanupUnknown,
    ServerLost,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowReceipt {
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub window_id: Uuid,
    pub generation: u64,
    pub state: WindowState,
    pub attempts: u32,
    pub reserved_bytes: u64,
    pub boot_id: Uuid,
    pub opened_at_ms: i64,
    pub work_deadline_ms: i64,
    pub expires_at_ms: i64,
    pub limits: ExecutionWindowLimits,
    pub reason: Option<String>,
    pub outcome: Option<TerminalOutcome>,
    pub run_id: Option<Uuid>,
    pub terminal_event_id: Option<EventId>,
}
#[derive(Debug, Clone)]
pub enum ManagerReceipt {
    Idle {
        owner_id: OwnerId,
        conversation_id: ConversationId,
    },
    Window(Box<WindowReceipt>),
}
#[derive(Debug)]
pub struct AdmissionAck {
    pub receipt: WindowReceipt,
    pub fresh_window: bool,
    /// Exact full canonical success reply, including fresh_window. Not a grant.
    pub reply_sha256: String,
}
#[derive(Debug)]
pub struct BindAck {
    pub receipt: WindowReceipt,
    pub fresh_child: bool,
}

#[derive(Clone)]
pub struct ManagerClient {
    socket: PathBuf,
    owner: OwnerId,
    conversation: ConversationId,
    manager_pid: u32,
    manager_start: u64,
}
impl ManagerClient {
    /// Preserve the original root manager PID/start and endpoint. Only the
    /// trusted authenticated controller may select another canonical scope.
    pub(super) fn for_conversation(&self, conversation: ConversationId) -> Result<Self> {
        if conversation.0.is_nil() {
            return Err(ManagerError::InvalidRequest);
        }
        self.parent()?;
        let mut selected = self.clone();
        selected.conversation = conversation;
        Ok(selected)
    }
    pub fn new(
        socket: PathBuf,
        owner: OwnerId,
        conversation: ConversationId,
        manager_pid: u32,
    ) -> Result<Self> {
        if !socket.is_absolute()
            || owner.0.is_nil()
            || conversation.0.is_nil()
            || !(2..(1 << 31)).contains(&manager_pid)
        {
            return Err(ManagerError::InvalidRequest);
        }
        let value = Self {
            socket,
            owner,
            conversation,
            manager_pid,
            manager_start: process(manager_pid)?.1,
        };
        value.parent()?;
        Ok(value)
    }
    fn parent(&self) -> Result<()> {
        if process(std::process::id())?.0 != self.manager_pid
            || process(self.manager_pid)?.1 != self.manager_start
        {
            return Err(ManagerError::Peer);
        }
        Ok(())
    }
    fn request(&self, operation: &str, request_id: &str, window: Option<&Window>) -> Result<Value> {
        if !key(request_id) {
            return Err(ManagerError::InvalidRequest);
        }
        let mut value = json!({"version":1,"operation":operation,"request_id":request_id,
            "owner_id":self.owner,"conversation_id":self.conversation});
        if let Some(window) = window {
            if window.window_id.is_nil()
                || window.generation == 0
                || window.generation >= INTEGER_LIMIT
            {
                return Err(ManagerError::InvalidRequest);
            }
            value["window_id"] = json!(window.window_id);
            value["generation"] = json!(window.generation);
        }
        Ok(value)
    }
    pub async fn status(&self, request_id: &str, deadline: Instant) -> Result<ManagerReceipt> {
        let (value, _) = self
            .exchange(self.request("status", request_id, None)?, deadline)
            .await?;
        success_fields(&value, None)?;
        self.receipt(&value["receipt"])
    }
    pub async fn admit(&self, admission: &Admission, deadline: Instant) -> Result<AdmissionAck> {
        let mut request = self.request("admit", &admission.request_id, Some(&admission.window))?;
        if admission.expected_generation >= INTEGER_LIMIT
            || admission.input_message_id.0.is_nil()
            || admission.input_event_id.0.is_nil()
            || admission
                .predecessor_window_id
                .is_some_and(|id| id.is_nil())
            || admission.input_request_key.is_empty()
            || admission.input_request_key.len() > 128
            || admission.input_request_key.chars().any(char::is_control)
            || !dates(
                admission.opened_at_ms,
                admission.work_deadline_ms,
                admission.expires_at_ms,
            )
        {
            return Err(ManagerError::InvalidRequest);
        }
        for (name, value) in [
            ("expected_generation", json!(admission.expected_generation)),
            ("input_message_id", json!(admission.input_message_id)),
            ("input_event_id", json!(admission.input_event_id)),
            ("input_request_key", json!(admission.input_request_key)),
            (
                "predecessor_window_id",
                json!(admission.predecessor_window_id),
            ),
            ("opened_at_ms", json!(admission.opened_at_ms)),
            ("work_deadline_ms", json!(admission.work_deadline_ms)),
            ("expires_at_ms", json!(admission.expires_at_ms)),
        ] {
            request[name] = value;
        }
        let (value, raw) = self.exchange(request, deadline).await?;
        success_fields(&value, Some("fresh_window"))?;
        let receipt = self.window_receipt(&value["receipt"], &admission.window)?;
        let fresh_window = boolean(&value, "fresh_window")?;
        if receipt.opened_at_ms != admission.opened_at_ms
            || receipt.work_deadline_ms != admission.work_deadline_ms
            || receipt.expires_at_ms != admission.expires_at_ms
            || (fresh_window && receipt.state != WindowState::Active)
        {
            return Err(ManagerError::Protocol);
        }
        Ok(AdmissionAck {
            receipt,
            fresh_window,
            reply_sha256: format!("{:x}", Sha256::digest(raw)),
        })
    }
    pub async fn drain(
        &self,
        request_id: &str,
        window: &Window,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        self.mutation(
            self.request("drain", request_id, Some(window))?,
            window,
            WindowState::Draining,
            deadline,
        )
        .await
    }
    /// Extend this active window's hard deadline (and work deadline, 30 s
    /// before it). The manager refuses shortening, a passed deadline and
    /// anything beyond its own lifetime ceiling; an equal request is a replay.
    pub async fn extend(
        &self,
        request_id: &str,
        window: &Window,
        expires_at_ms: i64,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        let mut request = self.request("extend", request_id, Some(window))?;
        request["expires_at_ms"] = json!(expires_at_ms);
        let receipt = self
            .mutation(request, window, WindowState::Active, deadline)
            .await?;
        if receipt.expires_at_ms != expires_at_ms {
            return Err(ManagerError::Protocol);
        }
        Ok(receipt)
    }
    pub async fn uncertain(
        &self,
        request_id: &str,
        window: &Window,
        reason: Uncertainty,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        let mut request = self.request("uncertain", request_id, Some(window))?;
        request["reason"] = json!(reason);
        self.mutation(request, window, WindowState::Reconciliation, deadline)
            .await
    }
    pub async fn retire(
        &self,
        request_id: &str,
        window: &Window,
        outcome: TerminalOutcome,
        run_id: Uuid,
        terminal_event_id: EventId,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        if matches!(
            outcome,
            TerminalOutcome::Abandoned | TerminalOutcome::Failed
        ) {
            return Err(ManagerError::InvalidRequest);
        }
        self.terminal(
            "retire",
            request_id,
            window,
            outcome,
            Some((run_id, terminal_event_id)),
            deadline,
        )
        .await
    }
    /// Release a stranded window (expired/reconciliation, no live custody in
    /// the manager) after Core prepared its audited decision. Idempotent.
    /// Only a `Failed` window may name no run (a failed open).
    pub async fn reconcile(
        &self,
        request_id: &str,
        window: &Window,
        outcome: TerminalOutcome,
        run: Option<(Uuid, EventId)>,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        self.terminal("reconcile", request_id, window, outcome, run, deadline)
            .await
    }
    async fn terminal(
        &self,
        operation: &str,
        request_id: &str,
        window: &Window,
        outcome: TerminalOutcome,
        run: Option<(Uuid, EventId)>,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        if (outcome != TerminalOutcome::Failed && run.is_none())
            || run
                .as_ref()
                .is_some_and(|(run_id, event)| run_id.is_nil() || event.0.is_nil())
        {
            return Err(ManagerError::InvalidRequest);
        }
        let (run_id, terminal_event_id) = run.unzip();
        let mut request = self.request(operation, request_id, Some(window))?;
        request["outcome"] = json!(outcome);
        request["run_id"] = json!(run_id);
        request["terminal_event_id"] = json!(terminal_event_id);
        let receipt = self
            .mutation(request, window, WindowState::Retired, deadline)
            .await?;
        if receipt.outcome != Some(outcome)
            || receipt.run_id != run_id
            || receipt.terminal_event_id != terminal_event_id
        {
            return Err(ManagerError::Protocol);
        }
        Ok(receipt)
    }
    /// Blocking setup worker ONLY, before FD3 receive/FD4 bootstrap. Never call
    /// from an async executor thread. The opaque locator is not signal authority.
    pub fn bind_child(
        &self,
        request_id: &str,
        window: &Window,
        child: &BrokerChildLocator,
        deadline: Instant,
    ) -> Result<BindAck> {
        let mut request = self.binding(request_id, window, child.pid(), child.start())?;
        request["bind_deadline_ms"] = json!(bind_deadline_ms(deadline)?);
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .map_err(|_| ManagerError::Unavailable)?
            .block_on(async {
                let (value, _) = self.exchange(request, deadline).await?;
                success_fields(&value, Some("fresh_child"))?;
                let receipt = self.window_receipt(&value["receipt"], window)?;
                if receipt.state != WindowState::Active {
                    return Err(ManagerError::Protocol);
                }
                Ok(BindAck {
                    receipt,
                    fresh_child: boolean(&value, "fresh_child")?,
                })
            })
    }
    fn binding(&self, request_id: &str, window: &Window, pid: u32, start: u64) -> Result<Value> {
        if !(2..(1 << 31)).contains(&pid) || start == 0 || start >= INTEGER_LIMIT {
            return Err(ManagerError::InvalidRequest);
        }
        let mut value = self.request("bind_child", request_id, Some(window))?;
        value["broker_pid"] = json!(pid);
        value["broker_start"] = json!(start);
        Ok(value)
    }
    async fn mutation(
        &self,
        request: Value,
        window: &Window,
        state: WindowState,
        deadline: Instant,
    ) -> Result<WindowReceipt> {
        let (value, _) = self.exchange(request, deadline).await?;
        success_fields(&value, None)?;
        let receipt = self.window_receipt(&value["receipt"], window)?;
        if receipt.state != state {
            return Err(ManagerError::Protocol);
        }
        Ok(receipt)
    }
    async fn exchange(&self, request: Value, deadline: Instant) -> Result<(Value, Vec<u8>)> {
        if Instant::now() >= deadline {
            return Err(ManagerError::Deadline);
        }
        let raw = canonical(request)?;
        if raw.is_empty() || raw.len() > MAX_FRAME {
            return Err(ManagerError::InvalidRequest);
        }
        let mut frame = (raw.len() as u32).to_be_bytes().to_vec();
        frame.extend(raw);
        let result = tokio::time::timeout_at(deadline.into(), async {
            self.parent()?;
            let stream = UnixStream::connect(&self.socket)
                .await
                .map_err(|_| ManagerError::Unavailable)?;
            let peer = stream.peer_cred().map_err(|_| ManagerError::Peer)?;
            if peer.uid() != 0 || peer.pid() != Some(self.manager_pid as i32) {
                return Err(ManagerError::Peer);
            }
            self.parent()?; // No request bytes reach an unverified or reparented peer.
            write(&stream, &frame).await?;
            let size = u32::from_be_bytes(
                read(&stream, 4)
                    .await?
                    .try_into()
                    .map_err(|_| ManagerError::Protocol)?,
            ) as usize;
            if size == 0 || size > MAX_FRAME {
                return Err(ManagerError::Protocol);
            }
            let raw = read(&stream, size).await?;
            // Manager closes after its sole reply. Waiting for EOF also rejects
            // delayed suffixes, without granting a second per-read deadline.
            loop {
                stream
                    .readable()
                    .await
                    .map_err(|_| ManagerError::Unavailable)?;
                match stream.try_read(&mut [0]) {
                    Ok(0) => break,
                    Ok(_) => return Err(ManagerError::Protocol),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(_) => return Err(ManagerError::Unavailable),
                }
            }
            self.parent()?;
            let value: Value = serde_json::from_slice(&raw).map_err(|_| ManagerError::Protocol)?;
            if canonical(value.clone())? != raw {
                return Err(ManagerError::Protocol);
            }
            if value.get("ok") == Some(&Value::Bool(false)) {
                match value.get("code").and_then(Value::as_str) {
                    Some("control_refused") if fields(&value, &["ok", "code", "receipt"]) => {
                        self.receipt(&value["receipt"])?;
                    }
                    Some("control_unavailable") if fields(&value, &["ok", "code"]) => {}
                    _ => return Err(ManagerError::Protocol),
                }
                return Err(ManagerError::Refused);
            }
            Ok((value, raw))
        })
        .await
        .map_err(|_| ManagerError::Deadline)?;
        if Instant::now() >= deadline {
            return Err(ManagerError::Deadline);
        }
        result
    }
    fn window_receipt(&self, value: &Value, window: &Window) -> Result<WindowReceipt> {
        match self.receipt(value)? {
            ManagerReceipt::Window(receipt)
                if receipt.window_id == window.window_id
                    && receipt.generation == window.generation =>
            {
                Ok(*receipt)
            }
            _ => Err(ManagerError::Protocol),
        }
    }
    fn receipt(&self, value: &Value) -> Result<ManagerReceipt> {
        if id(&value["owner_id"])? != self.owner.0
            || id(&value["conversation_id"])? != self.conversation.0
        {
            return Err(ManagerError::Protocol);
        }
        if value["state"] == "idle" {
            if !fields(
                value,
                &[
                    "owner_id",
                    "conversation_id",
                    "window_id",
                    "generation",
                    "state",
                ],
            ) || value["generation"].as_u64() != Some(0)
                || !value["window_id"].is_null()
            {
                return Err(ManagerError::Protocol);
            }
            return Ok(ManagerReceipt::Idle {
                owner_id: self.owner.clone(),
                conversation_id: self.conversation.clone(),
            });
        }
        if !fields(
            value,
            &[
                "owner_id",
                "conversation_id",
                "window_id",
                "generation",
                "state",
                "attempts",
                "reserved_bytes",
                "boot_id",
                "opened_at_ms",
                "work_deadline_ms",
                "expires_at_ms",
                "limits",
                "reason",
                "outcome",
                "run_id",
                "terminal_event_id",
            ],
        ) {
            return Err(ManagerError::Protocol);
        }
        for name in ["window_id", "boot_id", "run_id", "terminal_event_id"] {
            if !value[name].is_null() {
                id(&value[name])?;
            }
        }
        let r: WindowReceipt =
            serde_json::from_value(value.clone()).map_err(|_| ManagerError::Protocol)?;
        if r.generation == 0
            || r.generation >= INTEGER_LIMIT
            || r.attempts > 32
            || r.reserved_bytes > 67_108_864
            || r.limits != ExecutionWindowLimits::default()
            || !dates(r.opened_at_ms, r.work_deadline_ms, r.expires_at_ms)
            || r.reason.as_deref().is_some_and(|s| !reason_accepted(s))
            // Only a failed window may be retired without naming a run.
            || (r.state == WindowState::Retired
                && (r.outcome.is_none()
                    || (r.outcome != Some(TerminalOutcome::Failed) && r.run_id.is_none())
                    || r.run_id.is_none() != r.terminal_event_id.is_none()))
            || (r.state != WindowState::Retired
                && (r.outcome.is_some() || r.run_id.is_some() || r.terminal_event_id.is_some()))
        {
            return Err(ManagerError::Protocol);
        }
        Ok(ManagerReceipt::Window(Box::new(r)))
    }
}

/// Reasons this server knows the manager ledger to record.
const KNOWN_REASONS: [&str; 10] = [
    "manager_restarted",
    "clock_changed",
    "hard_deadline",
    "shutdown_margin",
    "runtime_drain",
    "runtime_refused",
    "auth_revoked",
    "cleanup_unknown",
    "server_lost",
    "manager_stopped",
];

/// A window's `reason` is a diagnostic, never authority. A newer manager may
/// record a reason this server does not know yet: refusing the whole receipt
/// for it silently blocked every reconcile path, so a well-formed closed token
/// is accepted with one warning per value. Anything else is still refused, and
/// says so.
fn reason_accepted(reason: &str) -> bool {
    if KNOWN_REASONS.contains(&reason) {
        return true;
    }
    let token = !reason.is_empty()
        && reason.len() <= 64
        && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    static WARNED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let first = WARNED
        .get_or_init(Default::default)
        .lock()
        .is_ok_and(|mut seen| seen.len() < 64 && seen.insert(reason.to_owned()));
    if token && first {
        eprintln!("WARN orkestr-v2-server manager_receipt_unknown_reason reason={reason}");
    } else if !token {
        // Never echo a malformed value: it is not a closed token.
        eprintln!(
            "WARN orkestr-v2-server manager_receipt_refused cause=malformed_reason length={}",
            reason.len()
        );
    }
    token
}

#[cfg(test)]
#[path = "manager_client_tests.rs"]
mod tests;
