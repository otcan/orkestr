use super::*;
impl Store {
    /// Output bytes are copied into the private reservation; Core computes their
    /// digest and fences exactly those suffixes, never caller-substituted bytes.
    pub async fn reserve_automatic_reply(
        &self,
        credential: &str,
        producer: &AutomaticReplyProducer,
        input: Uuid,
        key: &str,
        output: &[u8],
    ) -> Result<AutomaticReplyReservationResult> {
        if input.is_nil() || !text(key, 128) || output.is_empty() || output.len() > 65536 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        producer_in(self, &mut tx, credential, producer).await?;
        let revision = input_in(&mut tx, producer, input).await?;
        let digest = sha(output);
        let old=sqlx::query("SELECT * FROM automatic_reply_sends WHERE input_id=? OR (route_id=? AND request_key=?)")
            .bind(input.to_string()).bind(producer.route.to_string()).bind(key).fetch_all(&mut *tx).await.map_err(db)?;
        if !old.is_empty() {
            if old.len() != 1 {
                return Err(RuntimeStoreError::Conflict);
            }
            let row = &old[0];
            if row.get::<String, _>("input_id") != input.to_string()
                || row.get::<String, _>("route_id") != producer.route.to_string()
                || row.get::<i64, _>("route_generation") != producer.generation
                || row.get::<String, _>("account_scope") != producer.account_scope
                || row.get::<String, _>("request_key") != key
                || row.get::<String, _>("output_sha256") != digest
                || row.get::<i64, _>("byte_length") != output.len() as i64
            {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(AutomaticReplyReservationResult::Replay(receipt(row)?));
        }
        let id = Uuid::new_v4();
        let nonce = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO automatic_reply_sends(id,input_id,route_id,route_generation,permission_revision,request_key,output_sha256,byte_length,reservation_hash,account_scope,context_id,incarnation_id,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved')")
            .bind(id.to_string()).bind(input.to_string()).bind(producer.route.to_string()).bind(producer.generation).bind(revision).bind(key).bind(&digest).bind(output.len() as i64).bind(sha(nonce.as_bytes())).bind(&producer.account_scope).bind(&producer.context.id).bind(&producer.context.incarnation).execute(&mut *tx).await.map_err(db)?;
        let receipt = AutomaticReplySendReceipt {
            reservation_id: id,
            input_id: input,
            route_id: producer.route,
            route_generation: producer.generation,
            account_scope: producer.account_scope.clone(),
            permission_revision: revision,
            output_sha256: digest,
            byte_length: output.len() as u32,
            state: AutomaticReplySendState::Reserved,
            written_bytes: 0,
        };
        self.automatic_reply_checkpoint(true, false).await?;
        tx.commit().await.map_err(db)?;
        self.automatic_reply_checkpoint(true, true).await?;
        Ok(AutomaticReplyReservationResult::Reserved(
            AutomaticReplyReservation {
                producer: Box::new(copy_producer(producer)),
                receipt,
                bytes: output.to_vec(),
                nonce,
            },
        ))
    }
    /// Durable unknown precedes any external bytes. A lost response/reopen cannot
    /// reconstruct this nonserializable capability or turn it into fresh input.
    pub async fn consume_automatic_reply(
        &self,
        credential: &str,
        mut reservation: AutomaticReplyReservation,
    ) -> Result<AutomaticReplyConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        producer_in(self, &mut tx, credential, &reservation.producer).await?;
        let revision =
            input_in(&mut tx, &reservation.producer, reservation.receipt.input_id).await?;
        if revision != reservation.receipt.permission_revision {
            return Err(RuntimeStoreError::Fenced);
        }
        let row =
            sqlx::query("SELECT * FROM automatic_reply_sends WHERE id=? AND reservation_hash=?")
                .bind(reservation.receipt.reservation_id.to_string())
                .bind(sha(reservation.nonce.as_bytes()))
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::Fenced)?;
        if row.get::<&str, _>("state") != "reserved" {
            return Ok(AutomaticReplyConsumption::ReconciliationRequired);
        }
        if row.get::<String, _>("context_id") != reservation.producer.context.id
            || row.get::<String, _>("incarnation_id") != reservation.producer.context.incarnation
            || receipt(&row)? != reservation.receipt
            || sha(&reservation.bytes) != reservation.receipt.output_sha256
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let nonce = Uuid::new_v4().to_string();
        sqlx::query("UPDATE automatic_reply_sends SET state='delivery_unknown',delivery_hash=? WHERE id=? AND state='reserved'")
            .bind(sha(nonce.as_bytes())).bind(reservation.receipt.reservation_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        self.automatic_reply_checkpoint(false, false).await?;
        tx.commit().await.map_err(db)?;
        self.automatic_reply_checkpoint(false, true).await?;
        reservation.receipt.state = AutomaticReplySendState::DeliveryUnknown;
        Ok(AutomaticReplyConsumption::Deliver(AutomaticReplyDelivery {
            reservation: Box::new(reservation),
            nonce,
            offset: 0,
            poisoned: false,
        }))
    }
    async fn automatic_reply_checkpoint(&self, reserve: bool, after: bool) -> Result<()> {
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint(match (reserve, after) {
            (true, false) => "automatic-reply-reserve-before-commit",
            (true, true) => "automatic-reply-reserve-after-commit",
            (false, false) => "automatic-reply-consume-before-commit",
            (false, true) => "automatic-reply-consume-after-commit",
        })
        .await?;
        #[cfg(not(feature = "fixture-test-controls"))]
        let _ = (reserve, after);
        Ok(())
    }
}
