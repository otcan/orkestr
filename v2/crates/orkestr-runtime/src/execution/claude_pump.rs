//! First-turn Claude output, with actual native writes fenced on every suffix.
mod control;
mod lease;
use super::*;
use crate::{
    broker::claude::ClaudeChannel,
    claude_rpc::{ClaudeObservation, ClaudeRpc},
    containment::Output,
    ports::{InterruptControl, Provider, ProviderEvent, RunAdmission},
    supervisor::{self, PendingObservation},
};
pub use control::StoppingClaude;
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::Store;
use std::collections::VecDeque;

struct ClaudeOutput {
    child: OwnedChild,
    scope: ExecutionScope,
    admission: RunAdmission,
    channel: ClaudeChannel,
    rpc: ClaudeRpc,
    bytes: Vec<u8>,
    offset: usize,
    prepared: bool,
    started: bool,
    pending_native: bool,
    eof: bool,
    failed: bool,
    events: VecDeque<ProviderEvent>,
    correlation: super::claude_lifecycle::ClaudeInputCorrelation,
    completed: bool,
    models: super::model_evidence::ModelEvidence,
    policy_refused: bool,
}
impl ClaudeOutput {
    fn poll_inner(&mut self) -> Result<Option<ProviderEvent>, Blocker> {
        if self.models.pending() || (self.policy_refused && self.events.is_empty()) {
            return Ok(None);
        }
        if self.pending_native {
            return Ok(None);
        }
        if self.prepared && self.offset < self.bytes.len() {
            let end = (self.offset + 16384).min(self.bytes.len());
            let count = self
                .child
                .write_provider_suffix(&self.scope, &self.bytes[self.offset..end])
                .map_err(|_| Blocker::Protocol)?;
            self.offset += count;
            if self.offset == self.bytes.len() {
                self.channel.finish_write()?;
            } else {
                return Ok(None);
            }
        }
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        if self.eof {
            return Ok(None);
        }
        let bytes = match self
            .child
            .poll_stdout(&self.scope)
            .map_err(|_| Blocker::Protocol)?
        {
            Output::Pending => return Ok(None),
            Output::Frame(bytes) => bytes,
            Output::Eof => {
                self.eof = true;
                return if self.rpc.finish("turn:3").is_ok() {
                    Ok(None)
                } else {
                    Ok(Some(ProviderEvent::Lost))
                };
            }
        };
        let Some(frame) = self.channel.receive(&bytes)? else {
            if self.prepared {
                return Err(Blocker::Protocol);
            }
            self.channel.begin_write()?;
            self.prepared = true;
            return Ok(None);
        };
        self.correlation.verify(&frame)?;
        let observation = self.rpc.receive("turn:3", &frame.to_string())?;
        if let Some(model) = self.rpc.take_model_observation() {
            self.models.observe(model)?;
        }
        if observation == Some(ClaudeObservation::Initialized) {
            if self.started || self.pending_native {
                return Err(Blocker::Protocol);
            }
            self.pending_native = true;
            return Ok(None);
        }
        if !self.started && !matches!(observation, Some(ClaudeObservation::Failed) | None) {
            return Err(Blocker::Protocol);
        }
        match observation {
            Some(ClaudeObservation::PolicyRefusal) => {
                self.policy_refused = true;
                self.events.push_back(ProviderEvent::FailedWith(
                    orkestr_v2_contracts::ExecutionFailureClass::Policy,
                ));
            }
            Some(ClaudeObservation::Progress) => {
                // Only text from a fully validated bounded parser frame is persisted.
                if let Some(content) = frame
                    .pointer("/message/content")
                    .and_then(serde_json::Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                            if let Some(text) =
                                block.get("text").and_then(serde_json::Value::as_str)
                            {
                                if !text.is_empty() {
                                    self.events.push_back(ProviderEvent::Progress(text.into()));
                                }
                            }
                        }
                    }
                }
            }
            Some(ClaudeObservation::CompletedProposal) if self.rpc.terminal_result_seen() => {
                self.completed = true;
                self.events
                    .push_back(ProviderEvent::CompletedProposal { synthetic: false });
            }
            Some(ClaudeObservation::Failed) if self.rpc.terminal_result_seen() => {
                self.events.push_back(match self.rpc.failure_class() {
                    Some(class) => ProviderEvent::FailedWith(class),
                    None => ProviderEvent::Failed,
                })
            }
            Some(ClaudeObservation::Failed) => {} // notice is not a terminal result
            None => {} // Validated non-authoritative telemetry produces no event.
            _ => return Err(Blocker::Protocol),
        }
        if self.models.pending() {
            Ok(None)
        } else {
            Ok(self.events.pop_front())
        }
    }
}
impl Provider for ClaudeOutput {
    fn start(&mut self, _: &RunAdmission) -> Result<(), Blocker> {
        Err(Blocker::DispatchUnconfirmed)
    }
    fn interrupt(&mut self, _: &InterruptControl) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn poll(&mut self, admission: &RunAdmission) -> Result<Option<ProviderEvent>, Blocker> {
        if self.failed {
            return Err(Blocker::Protocol);
        }
        if admission != &self.admission {
            self.failed = true;
            self.child.quarantine();
            return Err(Blocker::StaleLease);
        }
        let result = self.poll_inner();
        if result.is_err() {
            self.failed = true;
            self.child.quarantine();
        }
        result
    }
}
/// No public constructor or reusable turn grant. Only ReadyClaude::attach can
/// construct this pump from a consumed Core capability and the same owned child.
pub struct ClaudePump {
    source: ClaudeOutput,
    cursor: PendingObservation,
    admission: ProviderAdmission,
}
impl ClaudePump {
    pub(super) fn new(
        child: OwnedChild,
        scope: ExecutionScope,
        admission: ProviderAdmission,
        channel: ClaudeChannel,
        rpc: ClaudeRpc,
        input: (Vec<u8>, super::claude_lifecycle::ClaudeInputCorrelation),
    ) -> Self {
        let (bytes, correlation) = input;
        Self {
            source: ClaudeOutput {
                child,
                scope,
                admission: admission.run.clone(),
                channel,
                rpc,
                bytes,
                offset: 0,
                prepared: false,
                started: false,
                pending_native: false,
                eof: false,
                failed: false,
                events: VecDeque::new(),
                correlation,
                completed: false,
                models: Default::default(),
                policy_refused: false,
            },
            cursor: PendingObservation::default(),
            admission,
        }
    }
    pub fn flush(&mut self) -> Result<(), crate::containment::Error> {
        if self.source.failed {
            return Err(crate::containment::Error::Revoked);
        }
        match self.source.child.flush_stdin(&self.source.scope) {
            Ok(_) => Ok(()),
            Err(error) => {
                self.source.failed = true;
                self.source.child.quarantine();
                Err(error)
            }
        }
    }
    #[cfg(test)]
    pub(super) fn awaiting_native_observation(&self) -> bool {
        self.source.pending_native
    }
    pub async fn step(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        if self.source.failed {
            return Err(supervisor::Error::Provider(Blocker::Protocol));
        }
        if self.source.pending_native {
            let key = format!(
                "claude-observed:{}:{}",
                self.admission.run.run_id, self.admission.binding.generation
            );
            let result = store
                .observe_claude_session(&self.admission, self.source.channel.native(), &key)
                .await;
            if let Err(error) = result {
                if !matches!(
                    error,
                    orkestr_v2_application::runtime::RuntimeStoreError::Busy
                        | orkestr_v2_application::runtime::RuntimeStoreError::Unavailable
                ) {
                    self.source.failed = true;
                    self.source.child.quarantine();
                }
                return Err(supervisor::Error::Store(error));
            }
            self.source.pending_native = false;
            self.source.started = true;
            self.source.events.push_back(ProviderEvent::Started);
        }
        match self.source.models.flush(store, &self.admission).await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => {
                if !matches!(
                    error,
                    orkestr_v2_application::runtime::RuntimeStoreError::Busy
                        | orkestr_v2_application::runtime::RuntimeStoreError::Unavailable
                ) {
                    self.source.failed = true;
                    self.source.child.quarantine();
                }
                return Err(supervisor::Error::Store(error));
            }
        }
        supervisor::step(store, &mut self.source, &self.admission, &mut self.cursor).await
    }
    pub fn pending(&self) -> Option<&orkestr_v2_application::runtime::ProviderEventInput> {
        self.cursor.pending()
    }
    /// Consume the exact successful proposal transport. This grants only a
    /// cleanup witness; caller must still obtain independent owner acceptance
    /// and the one-use Core metadata grant before starting another child.
    pub fn retire_completed(
        mut self,
    ) -> Result<crate::containment::RetiringBroker, crate::containment::Error> {
        if self.source.failed
            || !self.source.started
            || !self.source.completed
            || self.source.pending_native
            || !self.source.events.is_empty()
            || self.source.offset != self.source.bytes.len()
            || self.cursor.pending().is_some()
            || self.cursor.rejected().is_some()
            || self.source.rpc.finish("turn:3").is_err()
        {
            return Err(crate::containment::Error::AuthorityProtocol);
        }
        self.source.child.retire_broker()
    }
}
