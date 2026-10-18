//! First-turn Claude output, with actual native writes fenced on every suffix.
use super::*;
use crate::{
    broker::claude::ClaudeChannel,
    claude_rpc::{ClaudeObservation, ClaudeRpc},
    containment::Output,
    ports::{InterruptControl, Provider, ProviderEvent, RunAdmission},
    supervisor::{self, PendingObservation},
};
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
    eof: bool,
    failed: bool,
    events: VecDeque<ProviderEvent>,
}
impl ClaudeOutput {
    fn poll_inner(&mut self) -> Result<Option<ProviderEvent>, Blocker> {
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
                return if self.rpc.finish("turn:2").is_ok() {
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
        let observation = self.rpc.receive("turn:2", &frame.to_string())?;
        if !self.started {
            self.started = true;
            self.events.push_back(ProviderEvent::Started);
        }
        match observation {
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
            Some(ClaudeObservation::CompletedProposal) if self.rpc.terminal_result_seen() => self
                .events
                .push_back(ProviderEvent::CompletedProposal { synthetic: false }),
            Some(ClaudeObservation::Failed) if self.rpc.terminal_result_seen() => {
                self.events.push_back(ProviderEvent::Failed)
            }
            Some(ClaudeObservation::Failed) => {} // notice is not a terminal result
            _ => return Err(Blocker::Protocol),
        }
        Ok(self.events.pop_front())
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
        bytes: Vec<u8>,
    ) -> Self {
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
                eof: false,
                failed: false,
                events: VecDeque::new(),
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
    pub async fn step(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        supervisor::step(store, &mut self.source, &self.admission, &mut self.cursor).await
    }
    pub fn pending(&self) -> Option<&orkestr_v2_application::runtime::ProviderEventInput> {
        self.cursor.pending()
    }
}
