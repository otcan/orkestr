//! One bounded provider read between durable acknowledgements. No dispatch entry.
use super::*;
use crate::{
    codex_rpc::TurnStream,
    containment::{ExecutionScope, Output},
    ports::{InterruptControl, Provider, ProviderEvent, RunAdmission},
    supervisor::{self, PendingObservation},
};
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::Store;

struct CodexOutput {
    child: OwnedChild,
    scope: ExecutionScope,
    admission: RunAdmission,
    stream: TurnStream,
    failed: Option<Blocker>,
    eof: bool,
    broker: Option<crate::broker::channel::BrokerChannel>,
}
impl Provider for CodexOutput {
    fn start(&mut self, _: &RunAdmission) -> Result<(), Blocker> {
        Err(Blocker::DispatchUnconfirmed)
    }
    fn interrupt(&mut self, _: &InterruptControl) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn poll(&mut self, admission: &RunAdmission) -> Result<Option<ProviderEvent>, Blocker> {
        if admission != &self.admission {
            return Err(Blocker::StaleLease);
        }
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        if let Some(event) = self.stream.next_event() {
            return Ok(Some(event));
        }
        if self.eof {
            return Ok(None);
        }
        let result = match self.child.poll_stdout(&self.scope) {
            Ok(Output::Pending) => return Ok(None),
            Ok(Output::Frame(bytes)) => {
                let bytes = match self.broker.as_mut() {
                    Some(broker) => match broker.receive(&bytes) {
                        Ok(Some(frame)) => frame.to_string().into_bytes(),
                        Ok(None) => return Ok(None),
                        Err(error) => {
                            self.failed = Some(error.clone());
                            return Err(error);
                        }
                    },
                    None => bytes,
                };
                let text = std::str::from_utf8(&bytes).map_err(|_| Blocker::Protocol);
                text.and_then(|text| self.stream.receive(text))
            }
            Ok(Output::Eof) => {
                self.eof = true;
                // Unexpected EOF is evidence of loss, never successful stop.
                if self.stream.finish().is_err() {
                    return Ok(Some(ProviderEvent::Lost));
                }
                return Ok(None);
            }
            Err(_) => Err(Blocker::Protocol),
        };
        if let Err(error) = result {
            self.failed = Some(error.clone());
            return Err(error);
        }
        Ok(self.stream.next_event())
    }
}

/// Private composition only. The caller transfers its already attached owned
/// child; neither this pump nor its protocol parser can acquire/start a turn.
/// PendingObservation retains original admission, sequence and body on Busy or
/// Unavailable; no subsequent stdout is read until the same receipt is accepted.
#[allow(
    dead_code,
    reason = "metadata attachment composition is independently gated"
)]
pub(super) struct CodexPump {
    source: CodexOutput,
    cursor: PendingObservation,
    admission: ProviderAdmission,
}
#[allow(
    dead_code,
    reason = "metadata attachment composition is independently gated"
)]
impl CodexPump {
    pub(super) fn new(
        child: OwnedChild,
        scope: ExecutionScope,
        admission: ProviderAdmission,
        stream: TurnStream,
    ) -> Self {
        Self {
            source: CodexOutput {
                child,
                scope,
                admission: admission.run.clone(),
                stream,
                failed: None,
                eof: false,
                broker: None,
            },
            cursor: PendingObservation::default(),
            admission,
        }
    }
    pub(super) fn with_broker(mut self, channel: crate::broker::channel::BrokerChannel) -> Self {
        self.source.broker = Some(channel);
        self
    }
    pub(super) fn flush(&mut self) -> Result<(), crate::containment::Error> {
        if self.source.failed.is_some() {
            return Err(crate::containment::Error::Revoked);
        }
        match self.source.child.flush_stdin(&self.source.scope) {
            Ok(_) => Ok(()),
            Err(error) => {
                self.source.failed = Some(Blocker::Protocol);
                Err(error)
            }
        }
    }
    pub(super) async fn step(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        supervisor::step(store, &mut self.source, &self.admission, &mut self.cursor).await
    }
    pub(super) fn pending(&self) -> Option<&orkestr_v2_application::runtime::ProviderEventInput> {
        self.cursor.pending()
    }
}
