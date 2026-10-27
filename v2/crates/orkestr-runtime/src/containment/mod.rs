//! Capability-scoped, bounded Linux child transport. This is not an OS sandbox.
//! Runtime owns provider protocols and the private consumed-turn adapter.
pub(crate) mod broker;
mod broker_frames;
mod cancellation;
mod claude_cancellation;
mod environment;
mod framing;
mod lease_refresh;
mod memory;
pub mod metadata;
mod process;
mod provider_fd;
mod reaper;
mod resume_bootstrap;
mod retirement;
pub use retirement::{ReapedBroker, RetiringBroker, NATIVE_ENDED_REAPED};
mod reuse;
mod scope;
mod sys;
mod workspace_launch;

pub use environment::ChildDirectories;
pub use framing::{Flush, Output, TransportBounds};
pub use process::{Exit, OwnedChild, Signal};
pub use scope::{Authority, DispatchFence, ExecutionScope, Executor, SubscriptionHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidScope,
    WrongScope,
    Revoked,
    AuthorityProtocol,
    Unsupported,
    InvalidPath,
    InvalidBounds,
    InvalidFrame,
    FrameTooLarge,
    Backpressure,
    Capacity,
    PipeClosed,
    TruncatedFrame,
    Io,
}

/// Implement ONLY on Runtime's private non-Clone wrapper around Core's consumed
/// provider dispatch. No production implementation/default is supplied here.
/// Scope, native binding and text must come exclusively from that capability.
#[allow(
    dead_code,
    reason = "Runtime consumed-capability adapter is registered separately"
)]
pub(crate) trait ConsumedTurn {
    fn broker_lineage(&self) -> Option<std::sync::Arc<()>> {
        None
    }
    fn into_submission(self) -> (ExecutionScope, Vec<u8>);
}

/// The consumed capability is never returned, even if no bytes were written.
/// Runtime must persist delivery-unknown/reconciliation; never auto-resubmit.
#[derive(Debug)]
#[allow(
    dead_code,
    reason = "Runtime consumed-capability adapter is registered separately"
)]
pub(crate) struct TurnFailure {
    pub cause: Error,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod retained_tests;

mod offline_result;
mod steering;
mod workspace_result;
