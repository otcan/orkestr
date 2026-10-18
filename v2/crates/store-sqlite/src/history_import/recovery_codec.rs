//! Exact outer receipt codec and transaction-local integrity guards.
use super::recovery_export::*;
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn restore_digest(request: &HistoryRecoveryRestoreRequest) -> Result<String> {
    request.validate()?;
    if !hex(&request.bundle.bundle_digest) {
        return Err(HistoryError::Invalid);
    }
    Ok(request_fingerprint(
        request.restore_id,
        &request.bundle.bundle_digest,
        request.original_namespace,
        request.delta_namespace,
    ))
}
pub(super) fn request_fingerprint(
    restore_id: Uuid,
    bundle_digest: &str,
    original: Uuid,
    delta: Uuid,
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"orkestr-history-recovery-restore-v1\0");
    hash.update(restore_id.as_bytes());
    hash.update(bundle_digest.as_bytes());
    hash.update(original.as_bytes());
    hash.update(delta.as_bytes());
    format!("{:x}", hash.finalize())
}

pub(super) fn rollback_digest(request: &HistoryRecoveryRollbackRequest) -> Result<String> {
    if request.restore_id.is_nil()
        || request.expected_revision < 1
        || request.request_key.is_empty()
        || request.request_key.len() > 128
        || request.request_key.chars().any(char::is_control)
    {
        return Err(HistoryError::Invalid);
    }
    let mut hash = Sha256::new();
    hash.update(b"orkestr-history-recovery-rollback-v1\0");
    hash.update(request.restore_id.as_bytes());
    hash.update((request.expected_revision as u64).to_be_bytes());
    hash.update((request.request_key.len() as u64).to_be_bytes());
    hash.update(request.request_key.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn encode(receipt: &HistoryRecoveryRestoreReceipt) -> String {
    json!({"restore_id":receipt.restore_id,"bundle_digest":receipt.bundle_digest,
        "original":receipt.original,"native_delta":receipt.native_delta})
    .to_string()
}
pub(super) fn decode(text: &str) -> Result<HistoryRecoveryRestoreReceipt> {
    if text.len() > 8192 {
        return Err(HistoryError::Conflict);
    }
    let value: Value = serde_json::from_str(text).map_err(|_| HistoryError::Conflict)?;
    let map = value.as_object().ok_or(HistoryError::Conflict)?;
    if map.len() != 4
        || !["restore_id", "bundle_digest", "original", "native_delta"]
            .iter()
            .all(|key| map.contains_key(*key))
    {
        return Err(HistoryError::Conflict);
    }
    let receipt = HistoryRecoveryRestoreReceipt {
        restore_id: serde_json::from_value(value["restore_id"].clone())
            .map_err(|_| HistoryError::Conflict)?,
        bundle_digest: value["bundle_digest"]
            .as_str()
            .ok_or(HistoryError::Conflict)?
            .to_string(),
        original: serde_json::from_value(value["original"].clone())
            .map_err(|_| HistoryError::Conflict)?,
        native_delta: serde_json::from_value(value["native_delta"].clone())
            .map_err(|_| HistoryError::Conflict)?,
    };
    if encode(&receipt) != text || receipt.restore_id.is_nil() || !hex(&receipt.bundle_digest) {
        return Err(HistoryError::Conflict);
    }
    Ok(receipt)
}

/// Verify exact two-child association and content before replay or rollback.
/// Outer rollback retains immutable initial receipt; children then both inactive.
pub(super) async fn verify_children(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    receipt: &HistoryRecoveryRestoreReceipt,
    rolled_back: bool,
) -> Result<()> {
    let rows = sqlx::query("SELECT namespace,kind,source_digest,initial_revision,initial_active FROM history_recovery_children WHERE owner_id=? AND restore_id=? ORDER BY kind")
        .bind(owner.to_string()).bind(receipt.restore_id.to_string())
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    if rows.len() != 2 || receipt.original.namespace == receipt.native_delta.namespace {
        return Err(HistoryError::Conflict);
    }
    for (row, (kind, initial)) in rows.iter().zip([
        ("native_delta", &receipt.native_delta),
        ("original", &receipt.original),
    ]) {
        if initial.schema_version != 1
            || initial.owner_id != *owner
            || initial.namespace.is_nil()
            || !matches!((initial.revision, initial.active), (1, true) | (2, false))
            || (kind == "native_delta" && (initial.revision != 1 || !initial.active))
            || row.get::<String, _>("kind") != kind
            || row.get::<String, _>("namespace") != initial.namespace.to_string()
            || row.get::<String, _>("source_digest") != initial.source_digest
            || row.get::<i64, _>("initial_revision") != initial.revision
            || row.get::<i64, _>("initial_active") != i64::from(initial.active)
        {
            return Err(HistoryError::Conflict);
        }
        let (_, current) = readback::verified(tx, owner, initial.namespace).await?;
        let mut expected = initial.clone();
        if rolled_back {
            expected.revision = 2;
            expected.active = false;
        }
        if current != expected {
            return Err(HistoryError::Conflict);
        }
    }
    Ok(())
}
