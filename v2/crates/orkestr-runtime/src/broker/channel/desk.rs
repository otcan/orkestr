//! One exact native call, retired by cancellation or one sealed result.
use super::*;
use crate::broker::desk_tool::PendingDeskLoginCall;
#[derive(Default)]
pub(super) struct DeskState {
    pub(super) enabled: bool,
    pub(super) pending: Option<PendingDeskLoginCall>,
    pub(super) result_pending: bool,
    seen: std::collections::HashSet<String>,
    calls: std::collections::HashSet<String>,
    cancelled: bool,
    retired: bool,
}
impl DeskState {
    pub(super) fn cancel(&mut self) {
        self.retired = self.pending.take().is_some();
        self.cancelled = true;
    }
}
impl BrokerChannel {
    pub(crate) fn enable_desk_login(&mut self) -> Result<(), Blocker> {
        if self.execution_claimed
            || self.pending.is_some()
            || self.next != 2
            || self.offline.enabled
            || self.workspace_tool.enabled
        {
            return Err(Blocker::Protocol);
        }
        self.desk.enabled = true;
        Ok(())
    }
    pub(crate) fn pending_desk_login(&self) -> Option<&PendingDeskLoginCall> {
        self.desk.pending.as_ref()
    }
    pub(super) fn accept_native_tool(&mut self, frame: &Value) -> Result<(), Blocker> {
        if self.desk.enabled {
            self.accept_desk_call(frame)
        } else if self.workspace_tool.enabled {
            self.accept_workspace_call(frame)
        } else {
            self.accept_offline_call(frame)
        }
    }
    fn accept_desk_call(&mut self, frame: &Value) -> Result<(), Blocker> {
        if self.desk.cancelled
            || self.terminal_observed
            || self.desk.pending.is_some()
            || self.pending.is_some()
            || self.desk.calls.len() >= 8
        {
            return Err(Blocker::Protocol);
        }
        let call = PendingDeskLoginCall::decode(
            frame,
            self.native.as_deref().ok_or(Blocker::Protocol)?,
            self.active_turn.as_deref().ok_or(Blocker::Protocol)?,
            self.lineage.clone().ok_or(Blocker::Protocol)?,
        )?;
        let native = call.native_call();
        let key = frame["id"].to_string();
        if self.desk.seen.contains(&key) || self.desk.calls.contains(&native.call_id) {
            return Err(Blocker::Protocol);
        }
        self.desk.seen.insert(key);
        self.desk.calls.insert(native.call_id);
        self.desk.pending = Some(call);
        Ok(())
    }
    pub(super) fn validate_desk_terminal(&self, frame: &Value) -> Result<(), Blocker> {
        if frame["method"] == "turn/completed"
            && (self.desk.pending.is_some()
                || self.desk.retired
                    && frame.pointer("/params/turn/status").and_then(Value::as_str)
                        != Some("interrupted"))
        {
            return Err(Blocker::Protocol);
        }
        Ok(())
    }
    pub(crate) fn desk_result(
        &mut self,
        frame: Value,
    ) -> Result<(std::sync::Arc<()>, Vec<u8>), Blocker> {
        if self.desk.cancelled
            || self.desk.result_pending
            || self.desk.pending.is_none()
            || self.terminal_observed
            || self.preparation != Some(Preparation::Written)
        {
            return Err(Blocker::Protocol);
        }
        let bytes = self.wrap("ToolResult", frame)?;
        self.pending.as_mut().ok_or(Blocker::Protocol)?.1 = None;
        self.desk.result_pending = true;
        Ok((self.lineage.clone().ok_or(Blocker::Protocol)?, bytes))
    }
}
