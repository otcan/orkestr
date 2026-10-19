//! Canonical replay variants. Legacy message bytes retain their original shape.
use crate::*;
use serde::{de, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ConversationEvent {
    MessageAccepted(EventEnvelope),
    ExecutionAccepted(ExecutionAcceptedEnvelope),
    ProviderObserved(ProviderObservedEnvelope),
    CancellationRequested(CancellationRequestedEnvelope),
    ProviderStopped(ProviderStoppedEnvelope),
    FixtureProviderObserved(FixtureProviderObservedEnvelope),
    FixtureCancellationRequested(FixtureCancellationRequestedEnvelope),
    FixtureProviderStopped(FixtureProviderStoppedEnvelope),
}
impl ConversationEvent {
    pub fn sequence(&self) -> i64 {
        match self {
            Self::MessageAccepted(e) => e.sequence,
            Self::ExecutionAccepted(e) => e.sequence,
            Self::ProviderObserved(e) => e.sequence,
            Self::CancellationRequested(e) => e.sequence,
            Self::ProviderStopped(e) => e.sequence,
            Self::FixtureProviderObserved(e) => e.sequence,
            Self::FixtureCancellationRequested(e) => e.sequence,
            Self::FixtureProviderStopped(e) => e.sequence,
        }
    }
    pub fn sse_name(&self) -> &'static str {
        match self {
            Self::MessageAccepted(_) => "message_accepted",
            Self::ExecutionAccepted(_) => "execution_accepted",
            Self::ProviderObserved(_) => "provider_observed",
            Self::CancellationRequested(_) => "cancellation_requested",
            Self::ProviderStopped(_) => "provider_stopped",
            Self::FixtureProviderObserved(_) => "fixture_provider_observed",
            Self::FixtureCancellationRequested(_) => "fixture_cancellation_requested",
            Self::FixtureProviderStopped(_) => "fixture_provider_stopped",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixtureProviderObservedEnvelope {
    pub event_id: EventId,
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub scope: Scope,
    pub aggregate_id: ConversationId,
    pub aggregate_version: i64,
    pub sequence: i64,
    pub occurred_at: String,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub payload_ref_or_safe_payload: FixtureProviderObserved,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixtureProviderObserved {
    pub kind: FixtureObservationTag,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub run_sequence: u64,
    pub observation: FixtureObservationKind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureObservationTag {
    FixtureProviderObserved,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FixtureObservationKind {
    Started,
    ApprovalRequested,
    CompletedProposal { synthetic: bool },
    Failed,
    Lost,
}
impl<'de> Deserialize<'de> for ConversationEvent {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Message(EventEnvelope),
            Acceptance(ExecutionAcceptedEnvelope),
            Production(ProviderObservedEnvelope),
            ProductionCancellation(CancellationRequestedEnvelope),
            ProductionStopped(ProviderStoppedEnvelope),
            Fixture(FixtureProviderObservedEnvelope),
            Cancellation(FixtureCancellationRequestedEnvelope),
            Stopped(FixtureProviderStoppedEnvelope),
        }
        match Wire::deserialize(d)? {
            Wire::Message(e)
                if e.schema_version == 1
                    && e.payload_ref_or_safe_payload.kind == "message_accepted" =>
            {
                Ok(Self::MessageAccepted(e))
            }
            Wire::Acceptance(e) if e.is_valid() => Ok(Self::ExecutionAccepted(e)),
            Wire::Production(e) if e.is_valid() => Ok(Self::ProviderObserved(e)),
            Wire::ProductionCancellation(e) if e.is_valid() => Ok(Self::CancellationRequested(e)),
            Wire::ProductionStopped(e) if e.is_valid() => Ok(Self::ProviderStopped(e)),
            Wire::Fixture(e)
                if e.schema_version == 2 && e.payload_ref_or_safe_payload.run_sequence > 0 =>
            {
                Ok(Self::FixtureProviderObserved(e))
            }
            Wire::Cancellation(e) if e.schema_version == 3 => {
                Ok(Self::FixtureCancellationRequested(e))
            }
            Wire::Stopped(e)
                if e.schema_version == 4 && e.payload_ref_or_safe_payload.run_sequence > 0 =>
            {
                Ok(Self::FixtureProviderStopped(e))
            }
            _ => Err(de::Error::custom("event variant/schema mismatch")),
        }
    }
}
