use super::*;
impl Store {
    pub async fn rollback_history(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &HistoryRollbackRequest,
    ) -> Result<HistoryRollbackReceipt> {
        if request.namespace.is_nil() {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let linked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM history_recovery_children WHERE owner_id=? AND namespace=?",
        )
        .bind(owner.to_string())
        .bind(request.namespace.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if linked != 0 {
            return Err(HistoryError::Conflict);
        }
        let (_, receipt) = readback::verified(&mut tx, owner, request.namespace).await?;
        if request.expected_revision != 1 {
            return Err(HistoryError::Conflict);
        }
        if receipt.active {
            let changed = sqlx::query("UPDATE history_imports SET active=0,revision=2,rolled_back_at=unixepoch() WHERE owner_id=? AND namespace=? AND revision=1 AND active=1")
                .bind(owner.to_string()).bind(request.namespace.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
            if changed.rows_affected() != 1 {
                return Err(HistoryError::Conflict);
            }
        }
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("history-rollback-before-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("history-rollback-after-commit")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        Ok(HistoryRollbackReceipt {
            schema_version: 1,
            owner_id: owner.clone(),
            namespace: request.namespace,
            import_revision: 1,
            revision: 2,
            active: false,
        })
    }
}
