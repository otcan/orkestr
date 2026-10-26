//! Correlated framing only. These bytes never confer dispatch authority.
use super::*;
mod offline;
mod workspace;
use workspace::WorkspaceState;
mod steering;
use offline::OfflineState;

/// Private owned-pipe framing state; a handle is not an execution capability.
pub(crate) struct BrokerChannel {
    handle: String,
    offline: OfflineState,
    workspace_tool: WorkspaceState,
    steering: Option<steering::Correlation>,
    steering_ids: std::collections::HashSet<String>,
    native: Option<String>,
    lineage: Option<std::sync::Arc<()>>,
    next: u64,
    pending: Option<(u64, Option<u64>)>,
    cancellation_pending: bool,
    poisoned: bool,
    execution_claimed: bool,
    terminal_observed: bool,
    active_turn: Option<String>,
    retired_turns: std::collections::HashSet<String>,
    last_execution_inner: u64,
    preparation: Option<Preparation>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Preparation {
    Awaiting,
    Prepared,
    Writing,
    Written,
}

/// Correlation proof only; no Clone, serialization, provider bytes or authority.
/// Actual writes separately require the issuer capability and current fence.
pub(crate) struct PreparedRequest {
    outer: u64,
    lineage: std::sync::Arc<()>,
}

impl OwnedMetadataHandle {
    pub(crate) fn into_channel(self) -> BrokerChannel {
        BrokerChannel {
            handle: self._handle,
            offline: OfflineState::default(),
            workspace_tool: WorkspaceState::default(),
            steering: None,
            steering_ids: std::collections::HashSet::new(),
            native: None,
            lineage: self.lineage,
            next: 2,
            pending: None,
            cancellation_pending: false,
            poisoned: false,
            execution_claimed: false,
            terminal_observed: false,
            active_turn: None,
            retired_turns: std::collections::HashSet::new(),
            last_execution_inner: 0,
            preparation: None,
        }
    }
}
impl BrokerChannel {
    pub(crate) fn cancellation(
        &mut self,
        frame: Value,
    ) -> Result<(std::sync::Arc<()>, Vec<u8>), Blocker> {
        if !self.execution_claimed
            || self.preparation != Some(Preparation::Written)
            || self.active_turn.is_none()
            || self.terminal_observed
        {
            return Err(Blocker::Protocol);
        }
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        let bytes = self.wrap("CancelExecution", frame)?;
        self.cancellation_pending = true;
        self.offline.cancel();
        self.workspace_tool.cancel();
        Ok((lineage, bytes))
    }
    /// Enable only for the actual-FD transport before submitting any setup.
    /// There is no downgrade after this selection.
    pub(crate) fn require_prepared(&mut self) -> Result<(), Blocker> {
        if self.poisoned || self.pending.is_some() || self.next != 2 || self.preparation.is_some() {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.preparation = Some(Preparation::Awaiting);
        Ok(())
    }
    pub(crate) fn take_prepared(&mut self) -> Result<PreparedRequest, Blocker> {
        if self.poisoned || self.preparation != Some(Preparation::Prepared) {
            return Err(Blocker::Protocol);
        }
        let outer = self.pending.ok_or(Blocker::Protocol)?.0;
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        self.preparation = Some(Preparation::Writing);
        Ok(PreparedRequest { outer, lineage })
    }
    /// Consume only after all bounded, individually fenced suffix writes finish.
    /// No provider response/acknowledgement is awaited inside a Core fence.
    pub(crate) fn finish_provider_write(&mut self, proof: PreparedRequest) -> Result<(), Blocker> {
        if self.poisoned
            || self.preparation != Some(Preparation::Writing)
            || self.pending.map(|p| p.0) != Some(proof.outer)
            || !self
                .lineage
                .as_ref()
                .is_some_and(|lineage| std::sync::Arc::ptr_eq(lineage, &proof.lineage))
        {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.preparation = Some(Preparation::Written);
        Ok(())
    }

    /// Only setup frames produced by the trusted protocol state machine.
    /// Containment separately validates metadata authority before submission.
    pub(crate) fn metadata(&mut self, frame: Value) -> Result<BrokerMetadataRequest, Blocker> {
        if self.execution_claimed {
            return Err(Blocker::Protocol);
        }
        let method = frame
            .get("method")
            .and_then(Value::as_str)
            .ok_or(Blocker::Protocol)?;
        if !matches!(
            method,
            "initialize" | "initialized" | "account/read" | "thread/start" | "thread/resume"
        ) {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        Ok(BrokerMetadataRequest {
            lineage,
            bytes: self.wrap("BrokerMetadata", frame)?,
        })
    }
    /// Correlation reservation only; the private consumed-capability wrapper
    /// must derive the actual turn frame and transport checks child lineage.
    pub(crate) fn reserve_execution(
        &mut self,
        inner_id: u64,
    ) -> Result<BrokerExecutionEnvelope, Blocker> {
        if self.poisoned
            || self.execution_claimed
            || self.pending.is_some()
            || self.next >= (1_u64 << 53)
        {
            return Err(Blocker::Protocol);
        }
        if inner_id == 0 || inner_id <= self.last_execution_inner {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.last_execution_inner = inner_id;
        self.execution_claimed = true;
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        let outer = self.next;
        self.next += 1;
        self.pending = Some((outer, Some(inner_id)));
        if self.preparation.is_some() {
            self.preparation = Some(Preparation::Awaiting);
        }
        Ok(BrokerExecutionEnvelope {
            lineage,
            handle: self.handle.clone(),
            outer,
        })
    }
    /// Correlation only: caller must have durably accepted the old proposal,
    /// retired old authority, and own a NEW exact consumed Core dispatch.
    pub(crate) fn reserve_continuation(
        &mut self,
        inner_id: u64,
    ) -> Result<BrokerExecutionEnvelope, Blocker> {
        if self.poisoned
            || !self.execution_claimed
            || !self.terminal_observed
            || self.pending.is_some()
            || self.offline.pending.is_some()
            || self.workspace_tool.pending.is_some()
            || self.active_turn.is_none()
            || self.preparation.is_some_and(|p| p != Preparation::Written)
            || inner_id <= self.last_execution_inner
            || self.retired_turns.len() >= 256
        {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.retired_turns
            .insert(self.active_turn.take().ok_or(Blocker::Protocol)?);
        self.terminal_observed = false;
        self.execution_claimed = false;
        self.reserve_execution(inner_id)
    }

    fn observe_turn(&mut self, frame: &Value) -> Result<(), Blocker> {
        let method = frame.get("method").and_then(Value::as_str);
        let turn = match method {
            Some(
                "item/agentMessage/delta" | "item/started" | "item/completed" | "model/rerouted",
            ) => frame.pointer("/params/turnId"),
            Some("turn/started" | "turn/completed") => frame.pointer("/params/turn/id"),
            _ => return Err(Blocker::Protocol),
        }
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(Blocker::Protocol)?;
        if self.terminal_observed
            || self.retired_turns.contains(turn)
            || self
                .active_turn
                .as_deref()
                .is_some_and(|active| active != turn)
        {
            return Err(Blocker::Protocol);
        }
        self.active_turn = Some(turn.to_owned());
        if method == Some("turn/completed") {
            if !matches!(
                frame.pointer("/params/turn/status").and_then(Value::as_str),
                Some("completed" | "failed" | "interrupted")
            ) {
                return Err(Blocker::Protocol);
            }
            self.terminal_observed = true;
        }
        Ok(())
    }

    fn wrap(&mut self, method: &str, frame: Value) -> Result<Vec<u8>, Blocker> {
        if self.poisoned || self.pending.is_some() || self.next >= (1_u64 << 53) {
            return Err(Blocker::Protocol);
        }
        let id = self.next;
        let inner = frame.get("id").and_then(Value::as_u64);
        let bytes =
            json!({"id":id,"method":method,"params":{"owned_handle":self.handle,"frame":frame}})
                .to_string()
                .into_bytes();
        if bytes.len() > 65536 {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.next += 1;
        self.pending = Some((id, inner));
        if self.preparation.is_some() {
            self.preparation = Some(Preparation::Awaiting);
        }
        Ok(bytes)
    }
    /// Unwrap only the current owned pipe's correlated reply/notification.
    /// Protocol/readiness/turn validation remains the provider parser's job.
    pub(crate) fn receive(&mut self, bytes: &[u8]) -> Result<Option<Value>, Blocker> {
        if self.poisoned {
            return Err(Blocker::Protocol);
        }
        let result = self.decode(bytes);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn decode(&mut self, bytes: &[u8]) -> Result<Option<Value>, Blocker> {
        if bytes.len() > 65536 {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Blocker::Protocol)?;
        crate::claude_rpc::unique_keys(std::str::from_utf8(bytes).map_err(|_| Blocker::Protocol)?)?;
        let object = value.as_object().ok_or(Blocker::Protocol)?;
        if object.len() != 2 {
            return Err(Blocker::Protocol);
        }
        if value.get("method").and_then(Value::as_str) == Some("BrokerPrepared") {
            let params = value
                .get("params")
                .and_then(Value::as_object)
                .ok_or(Blocker::Protocol)?;
            if self.preparation != Some(Preparation::Awaiting)
                || params.len() != 2
                || params.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
                || params.get("request_id").and_then(Value::as_u64) != self.pending.map(|p| p.0)
                || self.pending.is_none()
            {
                return Err(Blocker::Protocol);
            }
            self.preparation = Some(Preparation::Prepared);
            return Ok(None);
        }
        // Notifications from the already-written active turn can precede the
        // broker's cancellation preparation (or arrive during suffix writes).
        // This exception never admits a correlated ACK or new-turn output.
        let cancelling_output = (self.cancellation_pending
            || self.offline.result_pending
            || self.workspace_tool.result_pending
            || self.steering.is_some())
            && self.active_turn.is_some()
            && value.get("method").and_then(Value::as_str) == Some("BrokerOutput");
        if self.pending.is_some()
            && self.preparation.is_some()
            && self.preparation != Some(Preparation::Written)
            && !cancelling_output
        {
            return Err(Blocker::Protocol);
        }
        if value.get("method").and_then(Value::as_str) == Some("BrokerOutput") {
            if !self.execution_claimed {
                return Err(Blocker::Protocol);
            }
            let params = value["params"].as_object().ok_or(Blocker::Protocol)?;
            if params.len() != 2
                || params.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
            {
                return Err(Blocker::Protocol);
            }
            let frame = params
                .get("frame")
                .filter(|v| v.is_object())
                .ok_or(Blocker::Protocol)?;
            if frame.get("method").and_then(Value::as_str) == Some("item/tool/call") {
                if self.workspace_tool.enabled {
                    self.accept_workspace_call(frame)?;
                } else {
                    self.accept_offline_call(frame)?;
                }
                return Ok(None);
            }
            if frame.get("id").is_some() {
                return Err(Blocker::Protocol);
            }
            if frame.get("method").and_then(Value::as_str) == Some("model/observed") {
                // Evidence only: preserve all preparation/owned-handle fences
                // above, but never infer a native turn ID from settings.
                let params = &frame["params"];
                return Ok((!self.terminal_observed
                    && !self.cancellation_pending
                    && self.native.is_some()
                    && params.get("threadId").and_then(Value::as_str) == self.native.as_deref()
                    && params.get("requestId").and_then(Value::as_u64)
                        == Some(self.last_execution_inner))
                .then(|| frame.clone()));
            }
            self.validate_offline_terminal(frame)?;
            self.validate_workspace_terminal(frame)?;
            self.observe_turn(frame)?;
            return Ok(Some(frame.clone()));
        }
        let (outer, inner) = self.pending.ok_or(Blocker::Protocol)?;
        if value.get("id").and_then(Value::as_u64) != Some(outer) {
            return Err(Blocker::Protocol);
        }
        let result = value["result"].as_object().ok_or(Blocker::Protocol)?;
        if result.len() != 2
            || result.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
        {
            return Err(Blocker::Protocol);
        }
        let frame = result.get("frame").ok_or(Blocker::Protocol)?;
        if self.steering.is_some() {
            self.receive_steering(frame)?;
            self.pending = None;
            return Ok(None);
        }
        match inner {
            None if frame.is_null() => {}
            Some(id)
                if frame.is_object() && frame.get("id").and_then(Value::as_u64) == Some(id) => {}
            _ => return Err(Blocker::Protocol),
        }
        if self.execution_claimed {
            if let Some(turn) = frame.pointer("/result/turn/id").and_then(Value::as_str) {
                if self.retired_turns.contains(turn)
                    || self.active_turn.as_deref().is_some_and(|id| id != turn)
                {
                    return Err(Blocker::Protocol);
                }
                self.active_turn = Some(turn.to_owned());
            }
        }
        self.pending = None;
        self.cancellation_pending = false;
        if self.offline.result_pending {
            self.offline.result_pending = false;
            self.offline.pending = None;
        }
        if self.workspace_tool.result_pending {
            self.workspace_tool.result_pending = false;
            self.workspace_tool.pending = None;
        }
        Ok((!frame.is_null()).then(|| frame.clone()))
    }
}

/// Correlation/lineage metadata only, never a consumed dispatch capability.
pub(crate) struct BrokerExecutionEnvelope {
    pub(crate) lineage: std::sync::Arc<()>,
    handle: String,
    outer: u64,
}
impl BrokerExecutionEnvelope {
    pub(crate) fn wrap(self, frame: Value) -> Vec<u8> {
        json!({"id":self.outer,"method":"CommitExecution","params":{"owned_handle":self.handle,"frame":frame}}).to_string().into_bytes()
    }
}

/// Sealed setup submission, bound to one actual owned child; never inference.
pub(crate) struct BrokerMetadataRequest {
    lineage: std::sync::Arc<()>,
    bytes: Vec<u8>,
}
impl BrokerMetadataRequest {
    pub(super) fn sealed(lineage: std::sync::Arc<()>, bytes: Vec<u8>) -> Self {
        Self { lineage, bytes }
    }
    pub(crate) fn into_submission(self) -> (std::sync::Arc<()>, Vec<u8>) {
        (self.lineage, self.bytes)
    }
}

#[cfg(test)]
mod tests;
