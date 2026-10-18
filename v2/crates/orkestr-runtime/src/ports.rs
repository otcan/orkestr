//! Proposed application ports; durable implementation belongs to the core store.
//! Every method must finish its transaction before calling a provider.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    Fast,
    Deep,
    Worker,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admission {
    pub run_id: String,
    pub session_id: String,
    pub native_session_id: String,
    pub generation: u64,
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Progress(String),
    ApprovalRequested,
    Completed { synthetic: bool },
    Failed,
    Stopped,
    Lost,
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
}

/// Provider methods return promptly. Pending work is polled by a supervisor,
/// outside ingress transactions. Completion remains a proposal, never success.
pub trait Provider {
    fn start(&mut self, admission: &Admission) -> Result<(), Blocker>;
    fn poll(&mut self, admission: &Admission) -> Result<Option<ProviderEvent>, Blocker>;
    fn interrupt(&mut self, admission: &Admission) -> Result<(), Blocker>;
    fn resume(&mut self, _admission: &Admission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn fork(&mut self, _admission: &Admission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn steer(&mut self, _admission: &Admission, _text: &str) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
}

/// Core implements atomic generation checks, run/session evidence and recovery.
/// No blanket implementation or in-memory production fallback is supplied.
pub trait SessionStore {
    fn admit(&self, scope: &str, role: Role, run_id: &str) -> Result<Admission, Blocker>;
    fn record(&self, admission: &Admission, event: ProviderEvent) -> Result<(), Blocker>;
    /// Persist cancel_requested and increment the dispatch fence BEFORE interrupt.
    fn request_cancel(&self, run_id: &str) -> Result<Admission, Blocker>;
    /// Mark unconfirmed active attempts lost/blocked; never silently restart.
    fn recover(&self) -> Result<Vec<Admission>, Blocker>;
}

/// Store fencing is deliberately ordered before fallible provider interruption.
/// An error means cancellation is requested, not confirmed.
pub fn cancel<S: SessionStore, P: Provider>(
    store: &S,
    provider: &mut P,
    run_id: &str,
) -> Result<(), Blocker> {
    let fenced = store.request_cancel(run_id)?;
    provider.interrupt(&fenced)
}
