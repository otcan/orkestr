//! Proposed application ports; durable implementation belongs to the core store.
//! Every method must finish its transaction before calling a provider.
pub use orkestr_v2_application::runtime::{ProviderAdmission, ProviderEvent};

/// A cancellation fence authorizes control only, never a new execution admission.
#[derive(Clone, Debug)]
pub struct InterruptControl {
    pub original: ProviderAdmission,
    pub fence_generation: i64,
}
impl InterruptControl {
    pub fn for_admission(original: &ProviderAdmission, fence_generation: i64) -> Self {
        Self {
            original: original.clone(),
            fence_generation,
        }
    }
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
    fn start(&mut self, admission: &ProviderAdmission) -> Result<(), Blocker>;
    fn poll(&mut self, admission: &ProviderAdmission) -> Result<Option<ProviderEvent>, Blocker>;
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker>;
    fn resume(&mut self, _admission: &ProviderAdmission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn fork(&mut self, _admission: &ProviderAdmission) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
    fn steer(&mut self, _admission: &ProviderAdmission, _text: &str) -> Result<(), Blocker> {
        Err(Blocker::Unsupported)
    }
}
