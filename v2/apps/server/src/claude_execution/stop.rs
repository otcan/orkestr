//! Trusted ordinary-server adapter for one exact authenticated Claude control.
//! The existing mailbox supplies the receipt; this leaf grants no HTTP authority.
use super::LiveClaudeExecution;
use crate::stop_execution::StopProgress;
use orkestr_runtime::{
    containment::{Error as ContainmentError, ReapedBroker},
    execution::{StopFailure, StoppingClaude},
    ports::Blocker,
    supervisor,
};
use orkestr_v2_application::runtime::{CancelReceipt, ProviderEventInput, RuntimeStoreError};
use std::time::{Duration, Instant};

/// Retains the original authority even while its pump moves into cancellation.
/// Drop still cleans up. Neither a caller PID nor an asserted exit is accepted.
pub struct ClaudeStopExecution {
    live: LiveClaudeExecution,
    stopping: Option<StoppingClaude>,
    progress: StopProgress,
    deadline: Instant,
}

impl LiveClaudeExecution {
    pub fn can_stop(&self) -> bool {
        !self.quarantined && self.pump.as_ref().is_some_and(|pump| pump.can_stop())
    }
    pub fn into_stopping(
        mut self,
        receipt: &CancelReceipt,
    ) -> Result<ClaudeStopExecution, StopFailure> {
        if self.quarantined {
            return Err(StopFailure {
                cause: Blocker::StaleLease,
                pending: None,
                terminal: None,
            });
        }
        let pump = self.pump.take().ok_or(StopFailure {
            cause: Blocker::Protocol,
            pending: None,
            terminal: None,
        })?;
        let stopping = pump.into_stopping(self.store.clone(), receipt)?;
        Ok(ClaudeStopExecution {
            live: self,
            stopping: Some(stopping),
            progress: StopProgress::Pending,
            deadline: Instant::now() + Duration::from_secs(10),
        })
    }
}

impl ClaudeStopExecution {
    pub fn progress(&self) -> StopProgress {
        self.progress
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.stopping.as_ref().and_then(StoppingClaude::pending)
    }
    /// This witness is available only after genuine evidence, original cleanup
    /// and durable Stopped. Core still separately decides successor eligibility.
    pub fn into_reaped(mut self) -> Result<ReapedBroker, ContainmentError> {
        if self.progress != StopProgress::Stopped {
            return Err(ContainmentError::AuthorityProtocol);
        }
        self.stopping
            .take()
            .ok_or(ContainmentError::AuthorityProtocol)?
            .into_reaped()
    }
    pub async fn tick(&mut self) -> StopProgress {
        if matches!(
            self.progress,
            StopProgress::Stopped | StopProgress::ReconciliationRequired
        ) {
            return self.progress;
        }
        if Instant::now() >= self.deadline {
            return self.reconcile();
        }
        let Some(stopping) = self.stopping.as_mut() else {
            return self.reconcile();
        };
        if stopping.pending().is_none() && stopping.flush().is_err() {
            return self.reconcile();
        }
        match stopping.step(&self.live.store).await {
            Ok(_) if stopping.stopped() => self.progress = StopProgress::Stopped,
            Ok(_) => {
                self.progress = if stopping.acknowledged() {
                    StopProgress::InterruptAcknowledged
                } else {
                    StopProgress::Pending
                }
            }
            Err(supervisor::Error::Store(
                RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
            )) if stopping.pending().is_some() => {}
            Err(_) => return self.reconcile(),
        }
        self.progress
    }
    fn reconcile(&mut self) -> StopProgress {
        self.live.quarantine();
        self.progress = StopProgress::ReconciliationRequired;
        // Retain exact pending evidence until this owned lifecycle is retired;
        // no retry can reconstruct control or send more native bytes.
        self.progress
    }
}
