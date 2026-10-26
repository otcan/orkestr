//! A completed owned channel can spend only a NEW consumed Core run capability.
use super::*;
use crate::{codex_rpc::TurnStream, containment::Authority, ports::ProviderEvent};
use orkestr_v2_application::runtime::{ProviderAdmission, Role};
use orkestr_v2_store_sqlite::Store;
use std::sync::Arc;

fn same_session(previous: &ProviderAdmission, next: &ProviderAdmission, role: Role) -> bool {
    let old = &previous.binding;
    let new = &next.binding;
    matches!(role, Role::Deep | Role::Fast)
        && old.role == role
        && previous.run.role == role
        && new.role == role
        && old.provider_kind == ProviderKind::Codex
        && new.provider_kind == old.provider_kind
        && new.owner_id == old.owner_id
        && new.conversation_id == old.conversation_id
        && new.session_id == old.session_id
        && new.native_session_id == old.native_session_id
        && new.parent_session_id.is_none()
        && old.parent_session_id.is_none()
        && old.generation.checked_add(1) == Some(new.generation)
        && next.run.run_id != previous.run.run_id
        && next.run.owner_id == new.owner_id
        && next.run.conversation_id == new.conversation_id
        && next.run.session_id == new.session_id
        && next.run.native_session_id == new.native_session_id
        && next.run.role == new.role
        && next.run.purpose == AdmissionPurpose::Execution
}

#[cfg(test)]
mod tests;

impl CodexPump {
    /// The caller must first obtain owner acceptance and a fresh Core admission.
    /// No reconnect, process spawn, metadata replay, or replacement grant exists
    /// here. Every failure consumes the supplied capability and quarantines.
    pub fn attach_next(
        self,
        store: Store,
        capability: Box<ConsumedProviderDispatch>,
    ) -> Result<(Authority, Self), SubmissionFailure> {
        self.attach_next_role(store, capability, Role::Deep)
    }

    /// Fast-only continuation after owner acceptance and a fresh consumed Fast
    /// admission. Never accepts a Deep or Worker capability or changes roles.
    pub fn attach_next_fast(
        self,
        store: Store,
        capability: Box<ConsumedProviderDispatch>,
    ) -> Result<(Authority, Self), SubmissionFailure> {
        self.attach_next_role(store, capability, Role::Fast)
    }

    fn attach_next_role(
        mut self,
        store: Store,
        capability: Box<ConsumedProviderDispatch>,
        role: Role,
    ) -> Result<(Authority, Self), SubmissionFailure> {
        let provider = capability.provider().clone();
        if self.source.failed.is_some()
            || self.source.eof
            || self.source.writing.is_some()
            || self.source.steering.is_some()
            || (self.source.tool_write.is_some() || self.source.workspace_write.is_some())
            || (self.pending_offline_python().is_some() || self.pending_workspace_exec().is_some())
            || (self.source.tool_write.is_some() || self.source.workspace_write.is_some())
            || (self.pending_offline_python().is_some() || self.pending_workspace_exec().is_some())
            || self.cursor.pending().is_some()
            || self.cursor.rejected().is_some()
            || !matches!(
                self.source.stream.terminal(),
                Some(ProviderEvent::CompletedProposal { .. })
            )
            || !same_session(&self.admission, &provider, role)
            || capability.namespace() != self.source.scope.namespace()
            || capability.incarnation_id() != self.source.scope.incarnation_id()
        {
            return Err(SubmissionFailure::Protocol(Blocker::Protocol));
        }
        // Core's fresh consumed same-role run requires the previously occupied
        // binding to have been released. A CompletedProposal cannot be cancelled
        // into Ready; only explicit owner acceptance releases this generation.
        let (native, request_id) = self
            .source
            .stream
            .completed_continuation()
            .map_err(SubmissionFailure::Protocol)?;
        if provider.binding.native_session_id.as_deref() != Some(native.as_str()) {
            return Err(SubmissionFailure::Protocol(Blocker::UnknownSession));
        }
        let mut channel = self
            .source
            .broker
            .take()
            .ok_or(SubmissionFailure::Protocol(Blocker::Protocol))?;
        let envelope = channel
            .reserve_continuation(request_id)
            .map_err(SubmissionFailure::Protocol)?;
        let writing =
            super::provider_write::PendingWrite::new(&turn_frame(&capability, request_id))
                .map_err(SubmissionFailure::Protocol)?;
        let requested_model = turn_frame(&capability, request_id)
            .pointer("/params/model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let scope = execution_scope(&capability).map_err(SubmissionFailure::Transport)?;
        let fence = Arc::new(
            super::fence::StoreFence::from_consumed(store, &capability)
                .map_err(SubmissionFailure::Transport)?,
        );
        let turn = CodexTurn {
            capability,
            scope: scope.clone(),
            request_id,
            broker: Some(envelope),
        };
        let stream = TurnStream::new(&native, request_id).map_err(SubmissionFailure::Protocol)?;
        let (authority, child) = self
            .source
            .child
            .reattach_turn(&self.source.scope, turn, fence.clone())
            .map_err(|failure| SubmissionFailure::Transport(failure.cause))?;
        let pump = Self::new(child, scope, provider, stream)
            .with_native_model(self.source.native_model.clone(), requested_model.as_deref())
            .with_broker(channel)
            .with_provider_write(Some(writing));
        #[cfg(all(test, feature = "fixture-test-controls"))]
        let pump = pump.with_test_fence(fence);
        Ok((authority, pump))
    }
}
