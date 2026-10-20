use super::*;

/// Store-issued private locator. Metadata getters do not expose launch authority.
pub struct WorkspaceExecDelegation {
    pub(super) profile: Arc<WorkspaceExecProfile>,
    pub(super) id: Uuid,
    pub(super) parent: Box<ProviderAdmission>,
    pub(super) context_id: String,
    pub(super) incarnation: String,
    pub(super) locator: String,
    pub(super) source_digest: String,
    pub(super) expires_at_ms: i64,
}
impl WorkspaceExecDelegation {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn source_digest(&self) -> &str {
        &self.source_digest
    }
    pub fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
}

/// DeliveryUnknown committed before this unique, non-Clone capability is issued.
pub struct ConsumedWorkspaceExec {
    pub(super) profile: Arc<WorkspaceExecProfile>,
    pub(super) parent: Box<ProviderAdmission>,
    pub(super) context_id: String,
    pub(super) incarnation: String,
    pub(super) source: String,
    pub(super) expires_at_ms: i64,
    pub(super) receipt: Box<WorkspaceExecReceipt>,
    pub(super) spawn_spent: AtomicBool,
}
impl ConsumedWorkspaceExec {
    /// Immutable deadline from the committed one-use consume, never a renewal.
    pub fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
    pub fn id(&self) -> Uuid {
        self.receipt.delegation_id
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn source_digest(&self) -> &str {
        &self.receipt.source_digest
    }
    pub fn parent(&self) -> &ProviderAdmission {
        &self.parent
    }
    /// Immutable metadata from the committed consume, not present-day authority.
    pub fn receipt(&self) -> &WorkspaceExecReceipt {
        &self.receipt
    }
}

pub enum WorkspaceExecAdmission {
    Fresh(WorkspaceExecDelegation),
    Existing(WorkspaceExecReceipt),
}
pub enum WorkspaceExecConsumption {
    Launch(ConsumedWorkspaceExec),
    ReconciliationRequired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceExecState {
    Delegated,
    DeliveryUnknown,
    Completed,
    Failed,
    Cancelled,
    Blocked,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceExecReceipt {
    pub delegation_id: Uuid,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub parent_run_id: RunId,
    pub source_digest: String,
    pub revision: i64,
    pub state: WorkspaceExecState,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceExecOutcome {
    Completed,
    Failed,
    Cancelled,
}
