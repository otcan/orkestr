use super::*;

/// Bounded wire correlation only. Construction does not authorize any effect.
#[derive(Clone, PartialEq, Eq)]
pub struct OfflinePythonNativeCall {
    pub request_id: OfflinePythonNativeRequestId,
    pub call_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

/// Trusted executor supplies exact bytes only after the owned sandbox child has
/// terminated. Core computes the digest and rendered response; this is no grant.
pub struct OfflinePythonOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

pub struct OfflinePythonResultReservation {
    pub(super) launch: Box<ResultLineage>,
    pub(super) locator: String,
    pub(super) call: OfflinePythonNativeCall,
    pub(super) output_digest: String,
    pub(super) text: String,
    pub(super) success: bool,
}

// A private copy of immutable lineage, not another launch capability.
pub(super) struct ResultLineage {
    pub id: Uuid,
    pub parent: Box<ProviderAdmission>,
    pub context_id: String,
    pub incarnation: String,
    pub source_digest: String,
    pub expires_at_ms: i64,
}
impl ResultLineage {
    pub fn from_launch(launch: &ConsumedOfflinePython) -> Self {
        Self {
            id: launch.id(),
            parent: launch.parent.clone(),
            context_id: launch.context_id.clone(),
            incarnation: launch.incarnation.clone(),
            source_digest: launch.source_digest().into(),
            expires_at_ms: launch.expires_at_ms,
        }
    }
}

pub enum OfflinePythonResultPreparation {
    Reserved(OfflinePythonResultReservation),
    /// Includes a lost preparation reply. No private grant can be re-created.
    ReconciliationRequired,
}
pub enum OfflinePythonResultConsumption {
    Deliver(CompletedToolDelivery),
    ReconciliationRequired,
}

/// Issued once, after delivery_unknown commits. No Clone/serde/public constructor.
/// A failed or uncertain write permanently poisons this local capability.
pub struct CompletedToolDelivery {
    pub(super) reservation: Box<OfflinePythonResultReservation>,
    pub(super) nonce: String,
    pub(super) offset: usize,
    pub(super) poisoned: bool,
}
impl CompletedToolDelivery {
    pub fn delegation_id(&self) -> Uuid {
        self.reservation.launch.id
    }
    pub fn native_call(&self) -> &OfflinePythonNativeCall {
        &self.reservation.call
    }
    pub fn parent(&self) -> &ProviderAdmission {
        &self.reservation.launch.parent
    }
    pub fn source_digest(&self) -> &str {
        &self.reservation.launch.source_digest
    }
    /// Correlate Runtime's retained exact request source without exposing a
    /// constructor or requiring transport code to choose a hashing convention.
    pub fn matches_source(&self, source: &str) -> bool {
        !source.is_empty()
            && source.len() <= 32768
            && !source.contains('\0')
            && crate::digest(source) == self.source_digest()
    }
    pub fn output_digest(&self) -> &str {
        &self.reservation.output_digest
    }
    pub fn text(&self) -> &str {
        &self.reservation.text
    }
    pub fn success(&self) -> bool {
        self.reservation.success
    }
    pub fn written_bytes(&self) -> usize {
        self.offset
    }
}
