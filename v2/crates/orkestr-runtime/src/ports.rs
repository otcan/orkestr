//! Runtime-owned process capabilities; all durable authority belongs to core.
pub use orkestr_v2_contracts::runtime::{ObservationKind, RunAdmission};

/// A cancellation token can control an existing turn, never admit a new one.
#[derive(Clone, Debug)]
pub struct InterruptControl {
    pub original: RunAdmission,
    pub cancellation: RunAdmission,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Blocker {
    Unsupported,
    Busy,
    UnknownSession,
    StaleLease,
    QueueFull,
    FixtureOnly,
    Protocol,
    /// Core admission replay cannot yet distinguish a fresh provider dispatch.
    DispatchUnconfirmed,
}

/// Commands return promptly; ingress never waits here. Core owns durable checks.
pub trait Provider {
    fn start(&mut self, admission: &RunAdmission) -> Result<(), Blocker>;
    fn poll(&mut self, admission: &RunAdmission) -> Result<Option<ObservationKind>, Blocker>;
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker>;
    fn resume(&mut self, _admission: &RunAdmission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn fork(&mut self, _admission: &RunAdmission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn steer(&mut self, _admission: &RunAdmission, _text: &str) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
}
