//! Trusted server bootstrap inputs, never browser request DTOs or persisted credentials.
use super::ProviderKind;
use orkestr_v2_contracts::SessionId;

/// The caller is trusted server composition, after selecting a local subscription
/// provider. Namespace identifies that existing provider identity; never a browser field.
pub struct ProductionSupervisorConfig {
    pub provider: ProviderKind,
    pub namespace: String,
    pub supervisor_key: String,
    pub takeover: ProductionTakeover,
}

pub enum ProductionTakeover {
    First,
    ExpiredPredecessor { incarnation_id: String },
}

/// Evidence supplied by the trusted protocol adapter only after a successful
/// native session initialization/attachment handshake. A turn Started is not readiness.
/// No secret credentials or transcript are accepted here. Debug intentionally omitted.
pub struct NativeSessionConfirmation {
    pub session_id: SessionId,
    pub expected_generation: u64,
    pub native_session_id: String,
    pub protocol_version: String,
    pub source_event_key: String,
}
