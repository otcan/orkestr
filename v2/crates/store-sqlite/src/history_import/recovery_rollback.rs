//! Both-child rollback, retaining immutable restore and rollback receipts.
use super::recovery_codec as codec;
use super::recovery_export::*;
use super::*;

impl Store {
    pub async fn rollback_history_recovery(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &HistoryRecoveryRollbackRequest,
    ) -> Result<HistoryRecoveryRollbackReceipt> {
        let digest = codec::rollback_digest(request)?;
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let row = sqlx::query("SELECT bundle_digest,request_digest,initial_receipt,revision,state,rollback_request_key,rollback_request_digest,rollback_receipt FROM history_recovery_restores WHERE owner_id=? AND restore_id=?")
            .bind(owner.to_string()).bind(request.restore_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(HistoryError::NotFound)?;
        let initial = codec::decode(&row.get::<String, _>("initial_receipt"))?;
        if initial.restore_id != request.restore_id
            || initial.bundle_digest != row.get::<String, _>("bundle_digest")
            || codec::request_fingerprint(
                initial.restore_id,
                &initial.bundle_digest,
                initial.original.namespace,
                initial.native_delta.namespace,
            ) != row.get::<String, _>("request_digest")
        {
            return Err(HistoryError::Conflict);
        }
        let revision: i64 = row.get("revision");
        let state: String = row.get("state");
        let receipt = HistoryRecoveryRollbackReceipt {
            restore_id: request.restore_id,
            revision: 2,
            active: false,
        };
        let encoded =
            serde_json::json!({"restore_id":receipt.restore_id,"revision":2,"active":false})
                .to_string();
        if revision == 2 && state == "rolled_back" {
            if row
                .get::<Option<String>, _>("rollback_request_digest")
                .as_deref()
                != Some(digest.as_str())
                || row
                    .get::<Option<String>, _>("rollback_request_key")
                    .as_deref()
                    != Some(request.request_key.as_str())
                || row.get::<Option<String>, _>("rollback_receipt").as_deref()
                    != Some(encoded.as_str())
            {
                return Err(HistoryError::Conflict);
            }
            codec::verify_children(&mut tx, owner, &initial, true).await?;
        } else {
            if revision != 1 || state != "active" || request.expected_revision != 1 {
                return Err(HistoryError::Conflict);
            }
            codec::verify_children(&mut tx, owner, &initial, false).await?;
            for child in [&initial.original, &initial.native_delta] {
                if child.active {
                    super::recovery_restore::deactivate(&mut tx, owner, child.namespace).await?;
                }
            }
            let changed = sqlx::query("UPDATE history_recovery_restores SET revision=2,state='rolled_back',rollback_request_key=?,rollback_request_digest=?,rollback_receipt=?,rolled_back_at=unixepoch() WHERE owner_id=? AND restore_id=? AND revision=1 AND state='active'")
                .bind(&request.request_key).bind(digest).bind(&encoded).bind(owner.to_string())
                .bind(request.restore_id.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
            if changed.rows_affected() != 1 {
                return Err(HistoryError::Conflict);
            }
            codec::verify_children(&mut tx, owner, &initial, true).await?;
        }
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("recovery-rollback-before-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("recovery-rollback-after-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        Ok(receipt)
    }
}
