//! Recovery-only transfer contract checkpoint. Not registered; no restore writes.
//!
//! Ordinary inactive history reads remain unchanged. A future recovery exporter
//! must authenticate in its read transaction before calling verified readback,
//! capture native history in that same transaction, and recheck current auth
//! before returning any retained inactive text. No caller-provided cut attestation.
use super::*;

/// One verified inert ledger and the native conversation delta at a single cut.
/// This is content recovery, not restoration of native execution state.
#[derive(Debug, Clone)]
pub struct HistoryRecoveryBundle {
    pub schema_version: u32,
    pub original: HistoryImportRequest,
    pub current_receipt: HistoryImportReceipt,
    pub native_delta: HistoryImportRequest,
    /// Domain-separated digest of source fingerprints and current ledger state.
    pub bundle_digest: String,
}

/// Target credentials are a separate method argument, never transferable data.
/// Both namespaces must be fresh and distinct; original inactivity is retained.
#[derive(Debug, Clone)]
pub struct HistoryRecoveryRestoreRequest {
    pub bundle: HistoryRecoveryBundle,
    pub original_namespace: Uuid,
    pub delta_namespace: Uuid,
}

#[derive(Debug, Clone)]
pub struct HistoryRecoveryRestoreReceipt {
    pub bundle_digest: String,
    pub original: HistoryImportReceipt,
    pub native_delta: HistoryImportReceipt,
}

/// Exact portable digest proposal for Core review, distinct from the JSON
/// collector envelope digest. Lengths are unsigned big-endian 64-bit integers.
/// Namespace and source-owner provenance are bound, not copied into target auth.
pub fn history_recovery_digest(bundle: &HistoryRecoveryBundle) -> Result<String> {
    use sha2::{Digest, Sha256};
    if bundle.schema_version != 1 {
        return Err(HistoryError::Invalid);
    }
    let original = &bundle.original;
    let delta = &bundle.native_delta;
    if history_source_digest(original)? != original.source_digest
        || history_source_digest(delta)? != delta.source_digest
    {
        return Err(HistoryError::Invalid);
    }
    let receipt = &bundle.current_receipt;
    if receipt.schema_version != 1
        || receipt.owner_id.0.is_nil()
        || receipt.namespace != original.namespace
        || receipt.source_digest != original.source_digest
        || receipt.source_conversation_id != original.source_conversation_id
        || receipt.source_watermark != original.source_watermark
        || receipt.message_count != original.messages.len() as u64
        || !matches!((receipt.revision, receipt.active), (1, true) | (2, false))
    {
        return Err(HistoryError::Invalid);
    }
    let original_ids: std::collections::HashSet<_> = original
        .messages
        .iter()
        .map(|message| &message.message_id)
        .collect();
    if delta
        .messages
        .iter()
        .any(|message| original_ids.contains(&message.message_id))
    {
        return Err(HistoryError::Conflict);
    }
    let mut digest = Sha256::new();
    digest.update(b"orkestr-history-recovery-v1\0");
    digest.update(receipt.owner_id.0.as_bytes());
    for request in [original, delta] {
        digest.update(request.namespace.as_bytes());
        let bytes = fingerprint::canonical(request)?;
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    digest.update(receipt.revision.to_be_bytes());
    digest.update([u8::from(receipt.active)]);
    Ok(format!("{:x}", digest.finalize()))
}

impl HistoryRecoveryRestoreRequest {
    pub fn validate(&self) -> Result<()> {
        if self.original_namespace.is_nil()
            || self.delta_namespace.is_nil()
            || self.original_namespace == self.delta_namespace
            || history_recovery_digest(&self.bundle)? != self.bundle.bundle_digest
        {
            return Err(HistoryError::Invalid);
        }
        Ok(())
    }
}
