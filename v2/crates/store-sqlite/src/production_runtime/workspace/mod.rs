//! Linux64 operator project authority. No browser paths or imported grants.
use super::*;
use orkestr_v2_contracts::ConversationId;
use std::sync::{Arc, Mutex};
mod filesystem;
use filesystem::Installation;
pub use filesystem::{
    WorkspaceDescriptors, WorkspaceDirectoryIdentity, WorkspaceInstallation,
    WorkspaceOperatorAllowlist,
};
#[cfg(test)]
mod boundary_tests;
mod issuance;
mod launch;
mod restart;
#[cfg(test)]
mod tests;
mod validation;

#[derive(Default)]
pub(crate) struct Registry(Mutex<std::collections::BTreeMap<String, Arc<Installation>>>);
/// Local retained descriptors and immutable issuer context; not serializable.
pub struct WorkspaceGrant {
    project: String,
    generation: i64,
    conversation: ConversationId,
    context: Context,
    installation: Arc<Installation>,
}
pub struct WorkspaceLaunchReservation {
    grant: Box<WorkspaceGrant>,
    binding: Box<Binding>,
    id: String,
    nonce: String,
    metadata_key: String,
}
pub enum WorkspaceLaunchReservationResult {
    Reserved(WorkspaceLaunchReservation),
    ReconciliationRequired,
}
pub struct WorkspaceLaunch {
    reservation: WorkspaceLaunchReservation,
    attempted: bool,
}
pub enum WorkspaceLaunchConsumption {
    Launch(WorkspaceLaunch),
    ReconciliationRequired,
}
impl WorkspaceGrant {
    pub(super) fn exec_identity(&self) -> (&str, i64, &ConversationId) {
        (&self.project, self.generation, &self.conversation)
    }
    pub(super) fn exec_descriptors(&self) -> WorkspaceDescriptors<'_> {
        self.installation.descriptors()
    }

    fn retained(&self) -> Self {
        Self {
            project: self.project.clone(),
            generation: self.generation,
            conversation: self.conversation.clone(),
            context: self.context.clone(),
            installation: self.installation.clone(),
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation as u64
    }
}

#[cfg(test)]
mod restart_tests;
