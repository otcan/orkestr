//! This capability is issued by the SQLite adapter, not by caller-supplied IDs.
//! Kept in the issuing crate so no public application constructor can forge it.
use super::*;
use orkestr_v2_contracts::MessageId;

/// Non-Clone, nonserializable, no public constructor and no transcript Debug.
/// Executor must consume this by value. Getters expose context, not another grant.
/// DeliveryUnknown has already committed when this object becomes observable.
pub struct ConsumedProviderDispatch {
    pub(super) provider: ProviderAdmission,
    pub(super) message_id: MessageId,
    pub(super) source_event_id: orkestr_v2_contracts::EventId,
    pub(super) text: String,
    pub(super) namespace: String,
    pub(super) incarnation: String,
}
impl ConsumedProviderDispatch {
    pub fn provider(&self) -> &ProviderAdmission {
        &self.provider
    }
    pub fn message_id(&self) -> &MessageId {
        &self.message_id
    }
    pub fn source_event_id(&self) -> &orkestr_v2_contracts::EventId {
        &self.source_event_id
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn namespace(&self) -> &str {
        &self.namespace
    }
    pub fn incarnation_id(&self) -> &str {
        &self.incarnation
    }
}
pub enum ExecutionConsumption {
    Dispatch(Box<ConsumedProviderDispatch>),
    ReconciliationRequired,
}
