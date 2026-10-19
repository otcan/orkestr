//! One issued Claude cancellation, correlated terminal, then original-tree reap.
//! Neither acknowledgement nor local process death can become durable Stopped.
mod protocol;
#[cfg(test)]
mod tests;
mod write;
use super::*;
use crate::{
    broker::claude::control::{ClaudeControl, ControlFrame},
    containment::{ReapedBroker, RetiringBroker},
    execution::{cancellation_fence::CancellationFence, StopFailure},
};
use orkestr_v2_application::runtime::{
    CancelReceipt, ProviderEventInput, RunState, RuntimeStore, RuntimeStoreError,
};
use protocol::StopEvidence;
use write::ControlWrite;

pub struct StoppingClaude {
    child: Option<OwnedChild>,
    scope: ExecutionScope,
    channel: ClaudeControl,
    rpc: ClaudeRpc,
    correlation: super::super::claude_lifecycle::ClaudeInputCorrelation,
    fence: CancellationFence,
    writing: Option<ControlWrite>,
    written: bool,
    evidence: StopEvidence,
    next_sequence: u64,
    frames: u16,
    nonterminal: u16,
    retiring: Option<RetiringBroker>,
    reaped: Option<ReapedBroker>,
    pending: Option<ProviderEventInput>,
    stopped: bool,
    failed: bool,
}

impl ClaudePump {
    /// Consumes the exact live pump. Input identity was minted by consumed Core
    /// dispatch; the receipt must fence that same run, not merely name its UUID.
    pub fn into_stopping(
        self,
        store: Store,
        receipt: &CancelReceipt,
    ) -> Result<StoppingClaude, StopFailure> {
        let prepared = (|| {
            if self.source.failed
                || !self.source.started
                || self.source.completed
                || self.source.eof
                || self.source.pending_native
                || !self.source.events.is_empty()
                || self.source.offset != self.source.bytes.len()
                || self.cursor.pending().is_some()
                || self.cursor.rejected().is_some()
            {
                return Err(Blocker::Busy);
            }
            let input = self
                .source
                .correlation
                .input()
                .ok_or(Blocker::Unsupported)?
                .to_owned();
            let evidence = StopEvidence::new(self.source.channel.native(), &input)?;
            let sequence = self
                .cursor
                .next_control_sequence()
                .map_err(|_| Blocker::Busy)?;
            let fence =
                CancellationFence::new(store, &self.admission, receipt, self.source.scope.clone())
                    .map_err(|_| Blocker::StaleLease)?;
            Ok((input, evidence, sequence, fence))
        })();
        let (input, evidence, next_sequence, fence) = match prepared {
            Ok(value) => value,
            Err(cause) => {
                self.source.child.quarantine();
                return Err(StopFailure {
                    cause,
                    pending: self.cursor.pending().cloned(),
                    terminal: None,
                });
            }
        };
        let mut channel = self.source.channel.into_control(&input).map_err(|cause| {
            self.source.child.quarantine();
            StopFailure {
                cause,
                pending: None,
                terminal: None,
            }
        })?;
        let queued = channel.request().and_then(|(lineage, bytes)| {
            self.source
                .child
                .enqueue_claude_cancellation(&self.source.scope, &fence, &lineage, &input, &bytes)
                .map_err(|_| Blocker::Protocol)
        });
        if let Err(cause) = queued {
            self.source.child.quarantine();
            return Err(StopFailure {
                cause,
                pending: None,
                terminal: None,
            });
        }
        Ok(StoppingClaude {
            child: Some(self.source.child),
            scope: self.source.scope,
            channel,
            rpc: self.source.rpc,
            correlation: self.source.correlation,
            fence,
            writing: None,
            written: false,
            evidence,
            next_sequence,
            frames: 0,
            nonterminal: 0,
            retiring: None,
            reaped: None,
            pending: None,
            stopped: false,
            failed: false,
        })
    }
    /// Sampled transport availability only; current Core auth/fence is checked
    /// again when the exact authenticated cancellation receipt is consumed.
    pub fn can_stop(&self) -> bool {
        !self.source.failed
            && self.source.started
            && !self.source.completed
            && !self.source.eof
            && !self.source.pending_native
            && self.source.events.is_empty()
            && self.source.offset == self.source.bytes.len()
            && self.cursor.pending().is_none()
            && self.cursor.rejected().is_none()
            && self.source.correlation.input().is_some()
    }
}

impl StoppingClaude {
    pub fn acknowledged(&self) -> bool {
        self.evidence.acknowledged()
    }
    pub fn stopped(&self) -> bool {
        self.stopped
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.pending.as_ref()
    }
    pub fn drained_nonterminal(&self) -> u16 {
        self.nonterminal
    }
    /// Replacement still requires the separate Core resume/recovery grant.
    pub fn into_reaped(mut self) -> Result<ReapedBroker, crate::containment::Error> {
        if !self.stopped || self.failed {
            return Err(crate::containment::Error::AuthorityProtocol);
        }
        self.reaped
            .take()
            .ok_or(crate::containment::Error::AuthorityProtocol)
    }
    fn fail(&mut self) {
        self.failed = true;
        if let Some(child) = &self.child {
            child.quarantine();
        }
        // Dropping a retirement handle still owns cleanup, never a success proof.
        self.retiring = None;
    }
    pub fn flush(&mut self) -> Result<(), crate::containment::Error> {
        if self.failed || self.stopped {
            return Err(crate::containment::Error::Revoked);
        }
        let Some(child) = &self.child else {
            return Ok(());
        };
        if let Err(error) = child.flush_cancellation(&self.scope, &self.fence) {
            self.fail();
            return Err(error);
        }
        Ok(())
    }
    async fn persist(&mut self, store: &Store) -> Result<bool, supervisor::Error> {
        if self.reaped.is_none() || !self.evidence.confirmed() {
            self.fail();
            return Err(supervisor::Error::Provider(Blocker::Protocol));
        }
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
                    && receipt.state == RunState::Cancelled =>
            {
                self.pending = None;
                self.stopped = true;
                Ok(true)
            }
            Ok(_) => {
                self.fail();
                Err(supervisor::Error::Store(RuntimeStoreError::InvalidInput))
            }
            Err(error) => {
                if !matches!(
                    error,
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable
                ) {
                    self.fail();
                }
                Err(supervisor::Error::Store(error))
            }
        }
    }
    /// At most one bounded frame/write/wait per call. SQLite never spans native
    /// waits. Transient persistence errors retain the same exact observation.
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
        if let Some(retiring) = self.retiring.as_mut() {
            match retiring.poll_reaped() {
                Ok(None) => return Ok(false),
                Ok(Some(proof)) if proof.scope() == &self.scope => {
                    self.retiring = None;
                    self.reaped = Some(proof);
                    let run = &self.fence.control().run;
                    self.pending = Some(ProviderEventInput {
                        run_id: run.run_id.clone(),
                        session_id: run.session_id.clone(),
                        lease_generation: run.lease_generation,
                        dispatch_fence: run.dispatch_fence,
                        sequence: self.next_sequence,
                        event: ProviderEvent::Stopped,
                    });
                    return self.persist(store).await;
                }
                _ => {
                    self.fail();
                    return Err(supervisor::Error::Provider(Blocker::Protocol));
                }
            }
        }
        match self.read_step() {
            Ok(()) => Ok(false),
            Err(error) => {
                self.fail();
                Err(supervisor::Error::Provider(error))
            }
        }
    }
    fn begin_retirement(&mut self) -> Result<(), Blocker> {
        if !self.evidence.confirmed() || !self.written || self.writing.is_some() {
            return Err(Blocker::Protocol);
        }
        self.retiring = Some(
            self.child
                .take()
                .ok_or(Blocker::Protocol)?
                .retire_broker()
                .map_err(|_| Blocker::Protocol)?,
        );
        Ok(())
    }
    fn read_step(&mut self) -> Result<(), Blocker> {
        let child = self.child.as_ref().ok_or(Blocker::Protocol)?;
        if let Some(write) = self.writing.as_mut() {
            if write.write(&mut self.channel, |bytes| {
                child.write_cancellation_suffix(&self.scope, &self.fence, bytes)
            })? {
                self.writing = None;
                self.written = true;
            }
            return Ok(());
        }
        let bytes = match child
            .poll_stdout(&self.scope)
            .map_err(|_| Blocker::Protocol)?
        {
            Output::Pending => {
                if self.evidence.confirmed() {
                    self.begin_retirement()?;
                }
                return Ok(());
            }
            Output::Eof => return self.begin_retirement(),
            Output::Frame(bytes) => bytes,
        };
        self.frames = self
            .frames
            .checked_add(1)
            .filter(|count| *count <= 1024)
            .ok_or(Blocker::QueueFull)?;
        match self.channel.receive(&bytes)? {
            ControlFrame::Prepared => {
                if self.writing.is_some() || self.written {
                    return Err(Blocker::Protocol);
                }
                self.writing = Some(ControlWrite::prepare(&mut self.channel)?);
            }
            ControlFrame::Native(frame) => {
                let kind = frame
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(Blocker::Protocol)?;
                if matches!(kind, "control_response" | "result") {
                    if !self.written {
                        return Err(Blocker::Protocol);
                    }
                    self.evidence.receive(&frame)?;
                } else {
                    let telemetry = matches!(kind, "command_lifecycle" | "rate_limit_event");
                    if self.evidence.terminal_seen() && !telemetry {
                        return Err(Blocker::Protocol);
                    }
                    self.correlation.verify(&frame)?;
                    if !matches!(
                        self.rpc.receive("turn:3", &frame.to_string())?,
                        Some(ClaudeObservation::Progress) | None
                    ) {
                        return Err(Blocker::Protocol);
                    }
                    self.nonterminal = self.nonterminal.checked_add(1).ok_or(Blocker::QueueFull)?;
                }
            }
        }
        Ok(())
    }
}
