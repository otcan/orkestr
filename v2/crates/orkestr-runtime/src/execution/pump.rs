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
#[path = "control.rs"]
mod control;
pub use control::{StopFailure, StoppingCodex};

pub(super) struct CodexOutput {
    pub(super) child: OwnedChild,
    pub(super) scope: ExecutionScope,
    pub(super) admission: RunAdmission,
    pub(super) stream: TurnStream,
    pub(super) failed: Option<Blocker>,
    pub(super) eof: bool,
    pub(super) broker: Option<crate::broker::channel::BrokerChannel>,
    pub(super) steering: Option<super::steering::SteerWrite>,
    pub(super) tool_write: Option<super::offline_result::ToolResultWrite>,
    pub(super) workspace_write: Option<super::workspace_result::WorkspaceResultWrite>,
    pub(super) writing: Option<super::provider_write::PendingWrite>,
    pub(super) native_model: Option<String>,
    models: super::model_evidence::ModelEvidence,
    pub(super) capacity: super::capacity::CapacityRetry,
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
        if self.models.pending() {
            return Ok(None);
        }
        if let Some(model) = self.stream.take_model_observation() {
            self.models.observe(model)?;
            return Ok(None);
        }
        if self.broker.as_ref().is_some_and(|b| b.steering_ack_ready()) {
            return Ok(None);
        }
        if self
            .tool_write
            .as_ref()
            .is_some_and(|w| w.prepared() && !w.finished())
        {
            return Ok(None);
        }
        if self
            .workspace_write
            .as_ref()
            .is_some_and(|w| w.prepared() && !w.finished())
        {
            return Ok(None);
        }
        if let Some(writing) = self.writing.as_mut() {
            if writing.prepared() {
                let result = writing
                    .write(self.broker.as_mut().ok_or(Blocker::Protocol)?, |bytes| {
                        self.child.write_provider_suffix(&self.scope, bytes)
                    });
                match result {
                    Ok(true) => self.writing = None,
                    Ok(false) => return Ok(None),
                    Err(_) => {
                        self.failed = Some(Blocker::Protocol);
                        self.child.quarantine();
                        return Err(Blocker::Protocol);
                    }
                }
            }
        }
        if let Some(event) = self.stream.next_event() {
            return Ok(Some(event));
        }
        if self.eof {
            return Ok(None);
        }
        let result = match self.child.poll_stdout(&self.scope) {
            Ok(Output::Pending) => {
                // Only with the pipe drained: a terminal already written by
                // the native is read before any stall interrupt.
                self.check_stall()?;
                return Ok(None);
            }
            Ok(Output::Frame(bytes)) => {
                let bytes = match self.broker.as_mut() {
                    Some(broker) => match broker.receive(&bytes) {
                        Ok(Some(frame)) => frame.to_string().into_bytes(),
                        Ok(None) => {
                            if serde_json::from_slice::<serde_json::Value>(&bytes)
                                .ok()
                                .is_some_and(|v| v["method"] == "BrokerPrepared")
                            {
                                if let Some(steering) = self.steering.as_mut() {
                                    steering.prepare(broker)?;
                                } else if let Some(tool) = self.tool_write.as_mut() {
                                    tool.prepare(broker)?;
                                } else if let Some(tool) = self.workspace_write.as_mut() {
                                    tool.prepare(broker)?;
                                } else {
                                    self.writing
                                        .as_mut()
                                        .ok_or(Blocker::Protocol)?
                                        .prepare(broker)?;
                                }
                            }
                            return Ok(None);
                        }
                        Err(error) => {
                            self.failed = Some(error.clone());
                            return Err(error);
                        }
                    },
                    None => bytes,
                };
                let text = std::str::from_utf8(&bytes).map_err(|_| Blocker::Protocol);
                text.and_then(|text| self.stream.receive(text))
                    .and_then(|()| self.resolve_capacity())
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
        while let Some(model) = self.stream.take_model_observation() {
            self.models.observe(model)?;
        }
        if self.models.pending() {
            Ok(None)
        } else {
            Ok(self.stream.next_event())
        }
    }
}

/// The native thread-start/resume model answers a turn that uses the thread
/// default, or that overrides with exactly that native-reported model (Codex
/// sends no settings update for an unchanged value). Any other override stays
/// unreported until the native itself confirms or reroutes it.
pub(super) fn native_model_evidence<'a>(
    native: Option<&'a str>,
    requested: Option<&str>,
) -> Option<&'a str> {
    match requested {
        None => native,
        Some(requested) => native.filter(|native| *native == requested),
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
pub struct CodexPump {
    pub(super) source: CodexOutput,
    pub(super) cursor: PendingObservation,
    pub(super) admission: ProviderAdmission,
    #[cfg(all(test, feature = "fixture-test-controls"))]
    test_fence: Option<std::sync::Arc<super::fence::StoreFence>>,
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
                writing: None,
                tool_write: None,
                workspace_write: None,
                steering: None,
                native_model: None,
                models: Default::default(),
                capacity: Default::default(),
            },
            #[cfg(all(test, feature = "fixture-test-controls"))]
            test_fence: None,
            cursor: PendingObservation::default(),
            admission,
        }
    }
    pub(super) fn with_broker(
        mut self,
        mut channel: crate::broker::channel::BrokerChannel,
    ) -> Self {
        channel.bind_tool_native(self.admission.binding.native_session_id.clone());
        self.source.broker = Some(channel);
        self
    }
    /// `requested` is the turn's explicit model override, if any. The native
    /// thread-start/resume model is evidence for a turn using that default or
    /// overriding with exactly the same native-reported model; any other
    /// override stays unreported until the native confirms it.
    pub(super) fn with_native_model(
        mut self,
        model: Option<String>,
        requested: Option<&str>,
    ) -> Self {
        self.source
            .stream
            .report_model(native_model_evidence(model.as_deref(), requested));
        self.source.native_model = model;
        self
    }
    pub(super) fn with_provider_write(
        mut self,
        writing: Option<super::provider_write::PendingWrite>,
    ) -> Self {
        self.source.writing = writing;
        self
    }
    /// Retain this turn's own frame for at most one same-run capacity
    /// fallback retry under the installed operator policy.
    pub(super) fn with_capacity_retry(mut self, frame: &serde_json::Value) -> Self {
        let actual_fd = self.source.writing.is_some();
        self.source.capacity = super::capacity::CapacityRetry::new(
            crate::capacity_fallback::current(),
            frame,
            actual_fd,
        );
        self
    }
    #[cfg(test)]
    pub(super) fn set_capacity_policy(
        &mut self,
        policy: crate::capacity_fallback::CapacityFallback,
    ) {
        self.source.capacity.set_policy(policy);
    }
    #[cfg(test)]
    pub(super) fn capacity_retried(&self) -> bool {
        self.source.capacity.attempted()
    }
    /// Consume the owned broker for descendant-aware cleanup. The returned
    /// evidence is not a Core continuation grant and never confirms Stopped.
    pub fn retire_broker(
        self,
    ) -> Result<crate::containment::RetiringBroker, crate::containment::Error> {
        self.source.child.retire_broker()
    }
    /// Peak resident memory of the owned broker tree; estimates only.
    pub fn tree_peak_rss_bytes(&self) -> Option<u64> {
        self.source.child.tree_peak_rss_bytes()
    }
    /// Idle observation only (no quarantine): has the owned broker exited?
    pub fn broker_exited(&self) -> Result<bool, crate::containment::Error> {
        Ok(self.source.child.poll_exit(&self.source.scope)?.is_some())
    }
    /// Claim an already-exited broker's own native-ended ECHILD status as
    /// retirement evidence. Anything else refuses; the caller quarantines.
    pub fn retire_ended_broker(
        self,
    ) -> Result<crate::containment::RetiringBroker, crate::containment::Error> {
        self.source.child.retire_ended_broker()
    }
    pub fn flush(&mut self) -> Result<(), crate::containment::Error> {
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
    pub async fn step(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        match self.source.models.flush(store, &self.admission).await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => {
                if !matches!(
                    error,
                    orkestr_v2_application::runtime::RuntimeStoreError::Busy
                        | orkestr_v2_application::runtime::RuntimeStoreError::Unavailable
                ) {
                    self.source.failed = Some(Blocker::Protocol);
                    self.source.child.quarantine();
                }
                return Err(supervisor::Error::Store(error));
            }
        }
        supervisor::step(store, &mut self.source, &self.admission, &mut self.cursor).await
    }
    #[cfg(test)]
    pub(super) fn prepared_for_provider_write(&self) -> bool {
        self.source.writing.as_ref().is_some_and(|w| w.prepared())
    }
    #[cfg(test)]
    pub(super) fn provider_offset(&self) -> usize {
        self.source.writing.as_ref().map_or(0, |w| w.offset())
    }
    #[cfg(all(test, feature = "fixture-test-controls"))]
    pub(super) fn with_test_fence(
        mut self,
        fence: std::sync::Arc<super::fence::StoreFence>,
    ) -> Self {
        self.test_fence = Some(fence);
        self
    }
    #[cfg(all(test, feature = "fixture-test-controls"))]
    pub(super) async fn arm_post_action_rollback(&self, marker: std::path::PathBuf) {
        assert!(self.prepared_for_provider_write());
        self.test_fence
            .as_ref()
            .unwrap()
            .arm_post_action_rollback(marker)
            .await;
    }
    pub fn pending(&self) -> Option<&orkestr_v2_application::runtime::ProviderEventInput> {
        self.cursor.pending()
    }

    /// Idle proposal/accepted states still own the exact broker. Observing its
    /// exit is local negative authority, not a provider terminal or reap proof.
    pub fn check_broker_liveness(&self) -> Result<(), crate::containment::Error> {
        match self.source.child.poll_exit(&self.source.scope) {
            Ok(None) => Ok(()),
            ended => {
                if let Ok(Some(exit)) = &ended {
                    // Original WNOWAIT observation, before quarantine signals
                    // the retained group. Numeric status is diagnostic only.
                    eprintln!(
                        "owned execution broker original exit: code={:?} signal={:?}",
                        exit.code, exit.signal
                    );
                } else if let Err(error) = &ended {
                    eprintln!("owned execution broker exit observation unavailable: {error:?}");
                }
                self.source.child.quarantine();
                Err(ended.err().unwrap_or(crate::containment::Error::PipeClosed))
            }
        }
    }
}
