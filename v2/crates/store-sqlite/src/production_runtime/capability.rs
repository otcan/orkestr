//! This capability is issued by the SQLite adapter, not by caller-supplied IDs.
//! Kept in the issuing crate so no public application constructor can forge it.
use super::*;
use orkestr_v2_contracts::MessageId;

/// Non-Clone, nonserializable, no public constructor and no transcript Debug.
/// Executor must consume this by value. Getters expose context, not another grant.
/// DeliveryUnknown has already committed when this object becomes observable.
pub struct ConsumedProviderDispatch {
    pub(super) provider: ProviderAdmission,
    pub(super) parent_run: Option<orkestr_v2_contracts::RunId>,
    pub(super) message_id: MessageId,
    pub(super) source_event_id: orkestr_v2_contracts::EventId,
    pub(super) text: String,
    pub(super) namespace: String,
    pub(super) incarnation: String,
    /// Conversation settings for Deep/Worker turns; None for Fast turns.
    pub(super) launch: Option<orkestr_v2_contracts::TurnLaunch>,
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
    /// Owner settings applied from this turn (model, effort, provider).
    pub fn launch(&self) -> Option<&orkestr_v2_contracts::TurnLaunch> {
        self.launch.as_ref()
    }
    /// Put one line of internal context before this turn's provider input
    /// only; the owner's stored message is unchanged. `false`, with the input
    /// unchanged, for anything but one plain line, or when the turn would no
    /// longer fit the providers' 32 KiB input bound.
    pub fn prepend_internal_note(&mut self, note: &str) -> bool {
        if note.is_empty()
            || note.chars().any(char::is_control)
            || note.len() + 2 + self.text.len() > PROVIDER_INPUT_MAX
        {
            return false;
        }
        self.text = format!("{note}\n\n{}", self.text);
        true
    }
}

/// Largest turn input both provider brokers accept (bytes).
const PROVIDER_INPUT_MAX: usize = 32_768;
pub enum ExecutionConsumption {
    Dispatch(Box<ConsumedProviderDispatch>),
    ReconciliationRequired,
}
