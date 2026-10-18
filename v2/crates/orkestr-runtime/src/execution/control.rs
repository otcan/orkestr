//! Same-child cancellation: issued control fences bytes; only terminal evidence
//! confirms Stopped. The RPC acknowledgement alone never changes durable state.
use super::*;
use crate::execution::{cancellation_fence::CancellationFence, provider_write::PendingWrite};
use orkestr_v2_application::runtime::{
    CancelReceipt, ProviderEventInput, RuntimeStore, RuntimeStoreError,
};

/// Failure preserves pending/terminal evidence; dropping it never returns a grant.
#[derive(Debug)]
pub struct StopFailure {
    pub cause: Blocker,
    pub pending: Option<ProviderEventInput>,
    pub terminal: Option<ProviderEvent>,
}

pub struct StoppingCodex {
    pump: CodexPump,
    fence: CancellationFence,
    writing: Option<PendingWrite>,
    request: u64,
    acknowledged: bool,
    next_sequence: u64,
    pending: Option<ProviderEventInput>,
    retained: Vec<ProviderEvent>,
    failed: bool,
    stopped: bool,
}

impl CodexPump {
    /// Caller first commits authenticated cancellation. This consumes the pump,
    /// preserves its execution read identity, and never acquires execution rights.
    pub fn into_stopping(
        mut self,
        store: Store,
        receipt: &CancelReceipt,
    ) -> Result<StoppingCodex, StopFailure> {
        let result = (|| {
            let next_sequence = self
                .cursor
                .next_control_sequence()
                .map_err(|_| Blocker::Busy)?;
            if self.source.failed.is_some()
                || self.source.eof
                || self.source.writing.is_some()
                || self.source.stream.terminal().is_some()
            {
                return Err(Blocker::Busy);
            }
            let fence =
                CancellationFence::new(store, &self.admission, receipt, self.source.scope.clone())
                    .map_err(|_| Blocker::StaleLease)?;
            // A protocol-only one-use id; Core-issued control remains mandatory.
            let request = (1_u64 << 53) - 1;
            let frame = self.source.stream.claim_interrupt(request)?;
            let writing = PendingWrite::new(&frame)?;
            let (lineage, bytes) = self
                .source
                .broker
                .as_mut()
                .ok_or(Blocker::Unsupported)?
                .cancellation(frame)?;
            self.source
                .child
                .enqueue_cancellation(&self.source.scope, &fence, &lineage, &bytes)
                .map_err(|_| Blocker::Protocol)?;
            Ok((fence, writing, next_sequence, request))
        })();
        match result {
            Ok((fence, writing, next_sequence, request)) => Ok(StoppingCodex {
                pump: self,
                fence,
                writing: Some(writing),
                request,
                acknowledged: false,
                next_sequence,
                pending: None,
                retained: Vec::new(),
                failed: false,
                stopped: false,
            }),
            Err(cause) => {
                self.source.child.quarantine();
                Err(StopFailure {
                    cause,
                    pending: self.cursor.pending().cloned(),
                    terminal: self.source.stream.terminal().cloned(),
                })
            }
        }
    }
}
impl StoppingCodex {
    pub fn retained(&self) -> &[ProviderEvent] {
        &self.retained
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.pending.as_ref()
    }
    pub fn acknowledged(&self) -> bool {
        self.acknowledged
    }
    pub fn stopped(&self) -> bool {
        self.stopped
    }
    fn quarantine(&mut self) {
        self.failed = true;
        self.pump.source.child.quarantine();
    }
    pub fn flush(&mut self) -> Result<(), crate::containment::Error> {
        if self.failed || self.stopped {
            return Err(crate::containment::Error::Revoked);
        }
        if let Err(error) = self
            .pump
            .source
            .child
            .flush_cancellation(&self.pump.source.scope, &self.fence)
        {
            self.quarantine();
            return Err(error);
        }
        Ok(())
    }
    async fn persist(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        let observation = self
            .pending
            .as_ref()
            .ok_or(supervisor::Error::Provider(Blocker::Protocol))?;
        let control = self.fence.control();
        match store
            .append_provider_event(&control.run.owner_id, control, observation)
            .await
        {
            Ok(receipt)
                if receipt.sequence == observation.sequence
                    && receipt.state == orkestr_v2_application::runtime::RunState::Cancelled =>
            {
                self.pending = None;
                self.stopped = true;
                self.pump.source.child.quarantine();
                Ok(true)
            }
            Ok(_) => {
                self.quarantine();
                Err(supervisor::Error::Store(RuntimeStoreError::InvalidInput))
            }
            Err(error) => {
                if !matches!(
                    error,
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable
                ) {
                    self.quarantine();
                }
                Err(supervisor::Error::Store(error))
            }
        }
    }
    /// One bounded frame or suffix. No wait/ACK is performed inside SQLite.
    pub async fn step(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        if self.failed {
            return Err(supervisor::Error::Provider(Blocker::Protocol));
        }
        if self.stopped {
            return Ok(false);
        }
        if self.pending.is_some() {
            return self.persist(store).await;
        }
        let result = self.read_step();
        match result {
            Ok(Some(ProviderEvent::Stopped)) => {
                let run = &self.fence.control().run;
                self.pending = Some(ProviderEventInput {
                    run_id: run.run_id.clone(),
                    session_id: run.session_id.clone(),
                    lease_generation: run.lease_generation,
                    dispatch_fence: run.dispatch_fence,
                    sequence: self.next_sequence,
                    event: ProviderEvent::Stopped,
                });
                self.persist(store).await
            }
            Ok(Some(event)) => {
                let terminal = matches!(
                    event,
                    ProviderEvent::CompletedProposal { .. }
                        | ProviderEvent::Failed
                        | ProviderEvent::Lost
                );
                if self.retained.len() >= 16 {
                    self.quarantine();
                    return Err(supervisor::Error::Provider(Blocker::QueueFull));
                }
                self.retained.push(event);
                if terminal {
                    self.quarantine();
                    return Err(supervisor::Error::Provider(Blocker::Busy));
                }
                Ok(false)
            }
            Ok(None) => Ok(false),
            Err(error) => {
                self.quarantine();
                Err(supervisor::Error::Provider(error))
            }
        }
    }
    fn read_step(&mut self) -> Result<Option<ProviderEvent>, Blocker> {
        let source = &mut self.pump.source;
        if let Some(writing) = self.writing.as_mut() {
            if writing.prepared() {
                match writing.write(source.broker.as_mut().ok_or(Blocker::Protocol)?, |bytes| {
                    source
                        .child
                        .write_cancellation_suffix(&source.scope, &self.fence, bytes)
                }) {
                    Ok(true) => self.writing = None,
                    Ok(false) => return Ok(None),
                    Err(_) => return Err(Blocker::Protocol),
                }
            }
        }
        if let Some(event) = source.stream.next_event() {
            return Ok(Some(event));
        }
        let bytes = match source
            .child
            .poll_stdout(&source.scope)
            .map_err(|_| Blocker::Protocol)?
        {
            Output::Pending => return Ok(None),
            Output::Eof => return Ok(Some(ProviderEvent::Lost)),
            Output::Frame(bytes) => bytes,
        };
        let channel = source.broker.as_mut().ok_or(Blocker::Protocol)?;
        let Some(frame) = channel.receive(&bytes)? else {
            self.writing
                .as_mut()
                .ok_or(Blocker::Protocol)?
                .prepare(channel)?;
            return Ok(None);
        };
        if frame.get("id").is_some() {
            let object = frame.as_object().ok_or(Blocker::Protocol)?;
            if self.acknowledged
                || object.len() != 2
                || frame.get("id").and_then(serde_json::Value::as_u64) != Some(self.request)
                || frame
                    .get("result")
                    .and_then(serde_json::Value::as_object)
                    .is_none_or(|r| !r.is_empty())
            {
                return Err(Blocker::Protocol);
            }
            self.acknowledged = true;
            return Ok(None);
        }
        source.stream.receive(&frame.to_string())?;
        Ok(source.stream.next_event())
    }
}
