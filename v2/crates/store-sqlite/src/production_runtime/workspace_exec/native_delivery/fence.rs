use super::*;

async fn current(
    store: &Store,
    conn: &mut SqliteConnection,
    credential: &str,
    delivery: &CompletedWorkspaceExecDelivery,
) -> Result<()> {
    let row = consume::current(store, conn, credential, &delivery.reservation).await?;
    if row.get::<&str, _>("state") != "delivery_unknown"
        || row.get::<Option<String>, _>("delivery_hash")
            != Some(hash(
                "workspace-exec-result-delivery-v1",
                &[&delivery.nonce],
            ))
        || row.get::<i64, _>("written_bytes") != delivery.offset as i64
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

impl Store {
    /// Only one bounded nonblocking native-stdin suffix belongs inside action.
    /// Runtime constructs the closed response from the sealed getters, matches
    /// its actual pending child/call, and supplies exact offset/offered length.
    /// Any error (including uncertain COMMIT) poisons the capability permanently.
    pub fn with_workspace_exec_result_fence<E>(
        &self,
        credential: &str,
        delivery: &mut CompletedWorkspaceExecDelivery,
        offset: usize,
        offered: usize,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        let invalid = delivery.poisoned
            || delivery.offset != offset
            || offered == 0
            || offered > 16384
            || offset.checked_add(offered).is_none_or(|end| end > 65536);
        delivery.poisoned = true;
        if invalid {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = {
            let operation = async {
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
                current(self, &mut tx, credential, delivery).await?;
                let result = action();
                if result.as_ref().is_ok_and(|written| *written > offered) {
                    return Err(RuntimeStoreError::Conflict);
                }
                if let Ok(written) = &result {
                    sqlx::query("UPDATE workspace_exec_results SET written_bytes=? WHERE delegation_id=? AND state='delivery_unknown'")
                    .bind((offset + written) as i64).bind(delivery.delegation_id().to_string())
                    .execute(&mut *tx).await.map_err(db)?;
                }
                tx.commit().await.map_err(db)?;
                Ok(result)
            };
            match tokio::runtime::Handle::try_current() {
                Ok(handle)
                    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread =>
                {
                    tokio::task::block_in_place(|| handle.block_on(operation))
                }
                Ok(_) => Err(RuntimeStoreError::Unavailable),
                Err(_) => tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(db)?
                    .block_on(operation),
            }
        };
        if let Ok(Ok(written)) = &result {
            delivery.offset += written;
            delivery.poisoned = false;
        }
        result
    }

    /// A fully written frame is delivery evidence only, never Worker completion
    /// or owner acceptance. The private capability is consumed even on refusal.
    pub async fn finish_workspace_exec_result(
        &self,
        credential: &str,
        delivery: CompletedWorkspaceExecDelivery,
        frame_len: usize,
    ) -> Result<()> {
        if delivery.poisoned || frame_len == 0 || frame_len > 65536 || delivery.offset != frame_len
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(self, &mut tx, credential, &delivery).await?;
        sqlx::query("UPDATE workspace_exec_results SET state='delivered' WHERE delegation_id=? AND state='delivery_unknown'")
            .bind(delivery.delegation_id().to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
