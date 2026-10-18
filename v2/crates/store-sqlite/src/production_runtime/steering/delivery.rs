use super::*;
async fn issued(
    store: &Store,
    conn: &mut SqliteConnection,
    reservation: &SteeringReservation,
) -> Result<sqlx::sqlite::SqliteRow> {
    current(store, conn, &reservation.authority).await?;
    let row=sqlx::query("SELECT s.*,m.text,t.native_turn_id FROM production_steering s JOIN messages m ON m.id=s.message_id JOIN production_steering_turns t ON t.run_id=s.run_id WHERE s.id=? AND s.run_id=?")
        .bind(reservation.id.to_string()).bind(reservation.authority.provider.run.run_id.to_string()).fetch_optional(&mut *conn).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
    let authenticated:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
        .bind(row.get::<String,_>("browser_token_hash")).bind(reservation.authority.provider.run.owner_id.to_string()).fetch_one(&mut *conn).await.map_err(db)?;
    if authenticated != 1 {
        return Err(RuntimeStoreError::Unauthorized);
    }
    if row.get::<String, _>("text") != reservation.text
        || row.get::<String, _>("native_turn_id") != reservation.turn
    {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(row)
}
async fn delivery_current(
    store: &Store,
    conn: &mut SqliteConnection,
    delivery: &ConsumedSteering,
) -> Result<()> {
    let row = issued(store, conn, &delivery.reservation).await?;
    if row.get::<&str, _>("state") != "delivery_unknown"
        || row.get::<Option<String>, _>("delivery_hash")
            != Some(hash("steering-delivery-v1", &[&delivery.nonce]))
        || row.get::<i64, _>("written_bytes") != delivery.offset as i64
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    /// Irreversible delivery_unknown COMMIT precedes returning any write grant.
    pub async fn consume_codex_steering(
        &self,
        reservation: SteeringReservation,
    ) -> Result<SteeringConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = issued(self, &mut tx, &reservation).await?;
        if matches!(
            row.get::<&str, _>("state"),
            "delivery_unknown" | "acknowledged" | "rejected"
        ) {
            return Ok(SteeringConsumption::ReconciliationRequired);
        }
        if row.get::<&str, _>("state") != "reserved"
            || row.get::<Option<String>, _>("grant_hash")
                != Some(hash("steering-grant-v1", &[&reservation.grant]))
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let nonce = secret();
        sqlx::query("UPDATE production_steering SET state='delivery_unknown',grant_hash=NULL,delivery_hash=? WHERE id=? AND state='reserved'")
            .bind(hash("steering-delivery-v1",&[&nonce])).bind(reservation.id.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(SteeringConsumption::Deliver(Box::new(ConsumedSteering {
            reservation,
            nonce,
            offset: 0,
            poisoned: false,
        })))
    }
    /// Bounded actual provider-FD write only; no framing queue or ACK wait.
    /// Any error/uncertain commit poisons local authority; no retry after effects.
    pub fn with_codex_steering_fence<E>(
        &self,
        delivery: &mut ConsumedSteering,
        offset: usize,
        offered: usize,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        let invalid = delivery.poisoned
            || offset != delivery.offset
            || offered == 0
            || offered > 16384
            || offset.checked_add(offered).is_none_or(|n| n > 65536);
        delivery.poisoned = true;
        if invalid {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = {
            let operation = async {
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
                delivery_current(self, &mut tx, delivery).await?;
                let effect = action();
                if let Ok(written) = &effect {
                    if *written > offered {
                        return Err(RuntimeStoreError::Conflict);
                    }
                    sqlx::query("UPDATE production_steering SET written_bytes=? WHERE id=? AND state='delivery_unknown'").bind((offset+written) as i64).bind(delivery.reservation.id.to_string()).execute(&mut *tx).await.map_err(db)?;
                }
                tx.commit().await.map_err(db)?;
                Ok(effect)
            };
            match tokio::runtime::Handle::try_current() {
                Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                    tokio::task::block_in_place(|| h.block_on(operation))
                }
                Ok(_) => Err(RuntimeStoreError::Unavailable),
                Err(_) => match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(h) => h.block_on(operation),
                    Err(e) => Err(db(e)),
                },
            }
        };
        if let Ok(Ok(written)) = &result {
            delivery.offset += written;
            delivery.poisoned = false;
        }
        result
    }
    /// Trusted Runtime must match actual response ID to request_id() and the
    /// same owned child. ACK is delivery evidence only, never completion/acceptance.
    /// Explicit native rejection remains consumed; it cannot become a fresh turn.
    pub async fn acknowledge_codex_steering(
        &self,
        delivery: ConsumedSteering,
        frame_len: usize,
        accepted: bool,
    ) -> Result<()> {
        if delivery.poisoned || frame_len == 0 || frame_len > 65536 || frame_len != delivery.offset
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        delivery_current(self, &mut tx, &delivery).await?;
        sqlx::query(
            "UPDATE production_steering SET state=? WHERE id=? AND state='delivery_unknown'",
        )
        .bind(if accepted { "acknowledged" } else { "rejected" })
        .bind(delivery.reservation.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)
    }
}
