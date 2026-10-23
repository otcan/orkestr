use super::*;
impl Store {
    /// Origin/CSRF belongs to the HTTP adapter. Original current session is
    /// authenticated inside this transaction before fresh AND replay lookup.
    /// None means unsupported transport: preserve ordered ordinary input.
    pub async fn steer_execution_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionSteeringRequest,
        authority: Option<&CodexSteeringAuthority>,
    ) -> Result<(ExecutionSteeringReceipt, Option<SteeringReservation>)> {
        if !input.is_valid() || !valid(&input.control.request_key) || conversation.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        browser(&mut tx, credential, &c.owner).await?;
        c.authenticate(&mut tx).await?;
        let digest = hash(
            "codex-steering-input-v1",
            &[
                &input.control.run_id.to_string(),
                &input.control.expected_revision.to_string(),
                &input.control.expected_control_revision.unwrap().to_string(),
                &input.text,
            ],
        );
        if let Some(row)=sqlx::query("SELECT * FROM production_steering WHERE owner_id=? AND conversation_id=? AND request_key=?").bind(c.owner.to_string()).bind(conversation.to_string()).bind(&input.control.request_key).fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("semantic_digest")!=digest {return Err(RuntimeStoreError::Conflict);}
            return Ok((types::receipt(&row)?,None));
        }
        c.validate(&mut tx).await?;
        let row=sqlx::query("SELECT r.*,v.revision AS control_revision FROM production_runs r JOIN production_control_revisions v ON v.run_id=r.id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(input.control.run_id.to_string()).bind(c.owner.to_string()).bind(conversation.to_string()).bind(&c.id).bind(&c.incarnation).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<&str, _>("role") != "deep"
            || row.get::<&str, _>("state") != "running"
            || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.production_authorized_run(&mut tx, &super::super::admission::envelope(&row)?)
            .await?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if input.control.expected_revision > revision
            || input.control.expected_control_revision != Some(row.get("control_revision"))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        // Never overtake an older unconsumed ordinary message or another steer.
        let queued:i64=sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox i WHERE conversation_id=? AND state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id)").bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let pending:i64=sqlx::query_scalar("SELECT count(*) FROM production_steering WHERE run_id=? AND state IN ('reserved','delivery_unknown')").bind(input.control.run_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let turn = if let Some(a) = authority {
            current(self, &mut tx, a).await?;
            if a.provider.run.run_id != input.control.run_id {
                return Err(RuntimeStoreError::Fenced);
            }
            sqlx::query_scalar::<_, String>(
                "SELECT native_turn_id FROM production_steering_turns WHERE run_id=?",
            )
            .bind(input.control.run_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        } else {
            None
        };
        let disposition = if turn.is_none() {
            "queued_unsupported"
        } else if queued != 0 || pending != 0 {
            "queued_ordered"
        } else {
            "reserved"
        };
        let id = Uuid::new_v4();
        let admitted = crate::intake::admit_in_transaction(
            &mut tx,
            &c.owner,
            conversation,
            &MessageInput {
                client_message_id: format!("steering:{id}"),
                text: input.text.clone(),
            },
        )
        .await
        .map_err(|_| RuntimeStoreError::Unavailable)?;
        let grant = (disposition == "reserved").then(secret);
        if grant.is_some() {
            let changed = sqlx::query(
                "UPDATE reasoning_inbox SET state='consumed' WHERE event_id=? AND state='queued'",
            )
            .bind(admitted.receipt.event_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
            if changed != 1 {
                return Err(RuntimeStoreError::Conflict);
            }
        }
        sqlx::query("INSERT INTO production_steering(id,owner_id,conversation_id,run_id,request_key,semantic_digest,browser_token_hash,message_id,event_id,scope_sequence,disposition,state,grant_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id.to_string()).bind(c.owner.to_string()).bind(conversation.to_string()).bind(input.control.run_id.to_string()).bind(&input.control.request_key).bind(digest)
        .bind(crate::digest(credential)).bind(admitted.receipt.message_id.to_string()).bind(admitted.receipt.event_id.to_string()).bind(admitted.receipt.sequence).bind(disposition).bind(if grant.is_some(){"reserved"}else{"queued"}).bind(grant.as_ref().map(|v|hash("steering-grant-v1",&[v]))).execute(&mut *tx).await.map_err(db)?;
        let row = sqlx::query("SELECT * FROM production_steering WHERE id=?")
            .bind(id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let receipt = types::receipt(&row)?;
        let reservation = match (authority, grant, turn) {
            (Some(a), Some(grant), Some(turn)) => Some(SteeringReservation {
                id,
                authority: CodexSteeringAuthority {
                    provider: a.provider.clone(),
                    context: a.context.clone(),
                    incarnation: a.incarnation.clone(),
                },
                grant,
                turn,
                text: input.text.clone(),
            }),
            _ => None,
        };
        tx.commit().await.map_err(db)?;
        Ok((receipt, reservation))
    }
}

impl Store {
    /// Read projection only. Reopening an unknown delivery never issues a grant.
    pub async fn steering_status_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        request_key: &str,
    ) -> Result<Option<orkestr_v2_contracts::ExecutionSteeringStatus>> {
        if !valid(request_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        browser(&mut tx, credential, &c.owner).await?;
        c.authenticate(&mut tx).await?;
        let row=sqlx::query("SELECT * FROM production_steering WHERE owner_id=? AND conversation_id=? AND request_key=?").bind(c.owner.to_string()).bind(conversation.to_string()).bind(request_key).fetch_optional(&mut *tx).await.map_err(db)?;
        use orkestr_v2_contracts::{ExecutionSteeringStatus, SteeringDeliveryState as S};
        let result = row
            .map(|r| {
                Ok(ExecutionSteeringStatus {
                    receipt: types::receipt(&r)?,
                    state: match r.get::<&str, _>("state") {
                        "queued" => S::Queued,
                        "reserved" => S::Reserved,
                        "delivery_unknown" => S::DeliveryUnknown,
                        "acknowledged" => S::Acknowledged,
                        "rejected" => S::Rejected,
                        _ => return Err(RuntimeStoreError::Unavailable),
                    },
                    written_bytes: u32::try_from(r.get::<i64, _>("written_bytes")).map_err(db)?,
                })
            })
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
