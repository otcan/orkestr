//! Opt-in Claude factory for trusted server composition; no router/main mutation.
//! The configured launcher owns canonical account selection. Browser JSON cannot
//! provide a launcher, account, native identity, setup grant or inference grant.
mod schedule;
mod stop;
pub use schedule::ClaudeSchedule;
pub use stop::ClaudeStopExecution;

use orkestr_runtime::{
    containment::{Authority, ChildDirectories},
    execution::{ClaudePump, PreparingClaude, ReadyClaude, SetupFailure, SubmissionFailure},
    supervisor,
};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, ConsumedProviderDispatch, Store};
use std::path::Path;

pub struct PreparingClaudeExecution {
    store: Store,
    preparing: PreparingClaude,
}
pub struct ReadyClaudeExecution {
    store: Store,
    ready: ReadyClaude,
}
pub struct LiveClaudeExecution {
    store: Store,
    authority: Authority,
    pump: Option<ClaudePump>,
    quarantined: bool,
}
impl PreparingClaudeExecution {
    pub fn open_retained(
        store: Store,
        grant: BoundSessionMetadata,
        trusted_launcher: &Path,
        owned_directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        let preparing = PreparingClaude::open_retained(
            store.clone(),
            grant,
            trusted_launcher,
            owned_directories,
            resources,
        )?;
        Ok(Self { store, preparing })
    }
    pub fn poll_ready(&mut self) -> Result<bool, SetupFailure> {
        self.preparing.poll()
    }
    pub async fn confirm(self) -> Result<ReadyClaudeExecution, SetupFailure> {
        Ok(ReadyClaudeExecution {
            store: self.store,
            ready: self.preparing.confirm().await?,
        })
    }
}
impl ReadyClaudeExecution {
    /// Caller performs ordinary admit/reserve/consume first. This attachment
    /// consumes exactly that issuer capability and cannot retry an uncertain run.
    pub fn attach(
        self,
        capability: Box<ConsumedProviderDispatch>,
    ) -> Result<LiveClaudeExecution, SubmissionFailure> {
        let (authority, pump) = self.ready.attach(self.store.clone(), capability)?;
        Ok(LiveClaudeExecution {
            store: self.store,
            authority,
            pump: Some(pump),
            quarantined: false,
        })
    }
}
impl LiveClaudeExecution {
    /// Parent-owned supervisor calls one bounded pump step; no detached task.
    /// Terminal proposal still requires the separate authenticated owner route.
    pub async fn tick(&mut self) -> Result<bool, supervisor::Error> {
        if self.quarantined {
            return Err(supervisor::Error::Provider(
                orkestr_runtime::ports::Blocker::Protocol,
            ));
        }
        let pump = self.pump.as_mut().ok_or(supervisor::Error::Provider(
            orkestr_runtime::ports::Blocker::Protocol,
        ))?;
        if pump.flush().is_err() {
            self.quarantine();
            return Err(supervisor::Error::Provider(
                orkestr_runtime::ports::Blocker::Protocol,
            ));
        }
        pump.step(&self.store).await
    }
    /// The exact pump must have committed its genuine completion proposal.
    /// This only closes owned transport; Core separately requires acceptance.
    pub fn retire_completed(
        mut self,
    ) -> Result<orkestr_runtime::containment::RetiringBroker, orkestr_runtime::containment::Error>
    {
        if self.quarantined {
            return Err(orkestr_runtime::containment::Error::Revoked);
        }
        self.pump
            .take()
            .ok_or(orkestr_runtime::containment::Error::Revoked)?
            .retire_completed()
    }
    /// Negative authority/owned cleanup only. Does not claim Stopped/Cancelled.
    pub fn quarantine(&mut self) {
        self.quarantined = true;
        let _ = self.authority.revoke();
    }
}
impl Drop for LiveClaudeExecution {
    fn drop(&mut self) {
        self.quarantine();
    }
}
