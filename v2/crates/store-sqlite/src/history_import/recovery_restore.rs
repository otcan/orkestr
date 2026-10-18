//! Schema-20-only atomic inert recovery restore. No native admissions.
use super::recovery_codec as codec;
use super::recovery_export::*;
use super::*;

impl Store {
    pub async fn restore_history_recovery(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &HistoryRecoveryRestoreRequest,
    ) -> Result<HistoryRecoveryRestoreReceipt> {
        let digest = codec::restore_digest(request)?;
        // Authentication precedes all persisted replay identity inspection.
        let mut tx = self.history_transaction(credential, owner, true).await?;
        if let Some(row) = sqlx::query("SELECT bundle_digest,request_digest,initial_receipt,revision,state FROM history_recovery_restores WHERE owner_id=? AND restore_id=?")
            .bind(owner.to_string()).bind(request.restore_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)? {
            if row.get::<String,_>("request_digest") != digest || row.get::<String,_>("bundle_digest") != request.bundle.bundle_digest {
                return Err(HistoryError::Conflict);
            }
            let receipt = codec::decode(&row.get::<String,_>("initial_receipt"))?;
            let rolled_back = match (row.get::<i64,_>("revision"),row.get::<String,_>("state").as_str()) {
                (1,"active") => false, (2,"rolled_back") => true, _ => return Err(HistoryError::Conflict),
            };
            if receipt.restore_id != request.restore_id || receipt.bundle_digest != request.bundle.bundle_digest
                || receipt.original != initial_child(owner, request.original_namespace, &request.bundle.original, request.bundle.current_receipt.active)
                || receipt.native_delta != initial_child(owner, request.delta_namespace, &request.bundle.native_delta, true) {
                return Err(HistoryError::Conflict);
            }
            codec::verify_children(&mut tx, owner, &receipt, rolled_back).await?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(receipt);
        }
        for namespace in [request.original_namespace, request.delta_namespace] {
            let occupied: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM history_imports WHERE owner_id=? AND namespace=?",
            )
            .bind(owner.to_string())
            .bind(namespace.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
            if occupied != 0 {
                return Err(HistoryError::Conflict);
            }
        }
        let mut original = request.bundle.original.clone();
        original.namespace = request.original_namespace;
        let mut delta = request.bundle.native_delta.clone();
        delta.namespace = request.delta_namespace;
        insert_history(&mut tx, owner, &original).await?;
        insert_history(&mut tx, owner, &delta).await?;
        if !request.bundle.current_receipt.active {
            deactivate(&mut tx, owner, original.namespace).await?;
        }
        let receipt = HistoryRecoveryRestoreReceipt {
            restore_id: request.restore_id,
            bundle_digest: request.bundle.bundle_digest.clone(),
            original: readback::verified(&mut tx, owner, original.namespace)
                .await?
                .1,
            native_delta: readback::verified(&mut tx, owner, delta.namespace).await?.1,
        };
        sqlx::query("INSERT INTO history_recovery_restores(owner_id,restore_id,bundle_digest,request_digest,initial_receipt) VALUES(?,?,?,?,?)")
            .bind(owner.to_string()).bind(request.restore_id.to_string()).bind(&receipt.bundle_digest)
            .bind(digest).bind(codec::encode(&receipt)).execute(&mut *tx).await.map_err(unavailable)?;
        for (kind, child) in [
            ("original", &receipt.original),
            ("native_delta", &receipt.native_delta),
        ] {
            sqlx::query("INSERT INTO history_recovery_children(owner_id,namespace,restore_id,kind,source_digest,initial_revision,initial_active) VALUES(?,?,?,?,?,?,?)")
                .bind(owner.to_string()).bind(child.namespace.to_string()).bind(request.restore_id.to_string())
                .bind(kind).bind(&child.source_digest).bind(child.revision).bind(i64::from(child.active))
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        codec::verify_children(&mut tx, owner, &receipt, false).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }
}
fn initial_child(
    owner: &OwnerId,
    namespace: Uuid,
    source: &HistoryImportRequest,
    active: bool,
) -> HistoryImportReceipt {
    HistoryImportReceipt {
        schema_version: 1,
        owner_id: owner.clone(),
        namespace,
        source_digest: source.source_digest.clone(),
        source_conversation_id: source.source_conversation_id.clone(),
        source_watermark: source.source_watermark,
        message_count: source.messages.len() as u64,
        revision: if active { 1 } else { 2 },
        active,
    }
}
pub(super) async fn deactivate(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<()> {
    let changed = sqlx::query("UPDATE history_imports SET active=0,revision=2,rolled_back_at=unixepoch() WHERE owner_id=? AND namespace=? AND revision=1 AND active=1")
        .bind(owner.to_string()).bind(namespace.to_string()).execute(&mut **tx).await.map_err(unavailable)?;
    if changed.rows_affected() != 1 {
        return Err(HistoryError::Conflict);
    }
    Ok(())
}
