use super::*;
async fn current(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    d: &AutomaticReplyDelivery,
) -> Result<()> {
    let r = &d.reservation;
    producer_in(store, tx, credential, &r.producer).await?;
    if input_in(tx, &r.producer, r.receipt.input_id).await? != r.receipt.permission_revision {
        return Err(RuntimeStoreError::Fenced);
    }
    let row=sqlx::query("SELECT * FROM automatic_reply_sends WHERE id=? AND delivery_hash=? AND state='delivery_unknown'")
        .bind(r.receipt.reservation_id.to_string()).bind(sha(d.nonce.as_bytes())).fetch_optional(tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
    let mut expected = r.receipt.clone();
    expected.written_bytes = d.offset as u32;
    if row.get::<String, _>("context_id") != r.producer.context.id
        || row.get::<String, _>("incarnation_id") != r.producer.context.incarnation
        || receipt(&row)? != expected
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    /// action must perform only one short nonblocking actual transport write.
    /// No network wait/ACK, async work, nested Store call, or effect retry is
    /// permitted under this SQLite writer lock. Bytes cannot be recalled.
    /// An action error, invalid byte count or uncertain COMMIT poisons the local
    /// capability forever; durable delivery_unknown remains reconciliation-only.
    pub fn with_automatic_reply_fence<E>(
        &self,
        credential: &str,
        delivery: &mut AutomaticReplyDelivery,
        offset: usize,
        offered: usize,
        action: impl FnOnce(&[u8]) -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        let invalid = delivery.poisoned
            || delivery.offset != offset
            || offered == 0
            || offered > 16384
            || offset
                .checked_add(offered)
                .is_none_or(|end| end > delivery.reservation.bytes.len());
        delivery.poisoned = true;
        if invalid {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = {
            let operation = async {
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
                current(self, &mut tx, credential, delivery).await?;
                let result = action(&delivery.reservation.bytes[offset..offset + offered]);
                if result.as_ref().is_ok_and(|n| *n > offered) {
                    return Err(RuntimeStoreError::Conflict);
                }
                if let Ok(n) = &result {
                    sqlx::query("UPDATE automatic_reply_sends SET written_bytes=? WHERE id=?")
                        .bind((offset + n) as i64)
                        .bind(delivery.reservation.receipt.reservation_id.to_string())
                        .execute(&mut *tx)
                        .await
                        .map_err(db)?;
                }
                tx.commit().await.map_err(db)?;
                Ok(result)
            };
            match tokio::runtime::Handle::try_current() {
                Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                    tokio::task::block_in_place(|| h.block_on(operation))
                }
                Ok(_) => Err(RuntimeStoreError::Unavailable),
                Err(_) => tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(db)?
                    .block_on(operation),
            }
        };
        if let Ok(Ok(n)) = &result {
            delivery.offset += n;
            delivery.poisoned = false;
        }
        result
    }
    /// Consumes the local capability. Fully written is still an unknown external
    /// effect, not sent/ACK evidence; no write capability is returned or reissued.
    pub async fn finish_automatic_reply_write(
        &self,
        credential: &str,
        delivery: AutomaticReplyDelivery,
    ) -> Result<AutomaticReplySendReceipt> {
        if delivery.poisoned || delivery.offset != delivery.reservation.bytes.len() {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(self, &mut tx, credential, &delivery).await?;
        tx.commit().await.map_err(db)?;
        let mut receipt = delivery.reservation.receipt;
        receipt.written_bytes = delivery.offset as u32;
        Ok(receipt)
    }
}
