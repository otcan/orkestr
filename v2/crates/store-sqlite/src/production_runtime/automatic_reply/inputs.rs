use super::*;
fn revision(value: &AutomaticReplySourceRevision) -> bool {
    match value {
        AutomaticReplySourceRevision::Unknown => true,
        AutomaticReplySourceRevision::Known(s) => {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
    }
}
fn valid(p: &AutomaticReplyPreservedInput) -> bool {
    !p.source_namespace.is_nil()
        && text(&p.source_input_identity, 512)
        && revision(&p.source_revision)
        && revision(&p.hold_source_revision)
        && p.created_at.len() <= 128
        && !p.created_at.chars().any(char::is_control)
        && !p.historical_effects.is_empty()
        && p.historical_effects.len() <= 5
        && p.historical_effects.iter().enumerate().all(|(i, e)| {
            !p.historical_effects[..i]
                .iter()
                .any(|old| old.classification == e.classification)
        })
}
impl Store {
    /// Fresh trusted ingress, distinct from imported evidence. Registration does
    /// not authorize an effect; permission/hold/current route are checked later.
    pub async fn register_automatic_reply_input(
        &self,
        credential: &str,
        producer: &AutomaticReplyProducer,
        source_namespace: Uuid,
        identity: &str,
    ) -> Result<AutomaticReplyInputReceipt> {
        if source_namespace.is_nil() || !text(identity, 512) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        producer_in(self, &mut tx, credential, producer).await?;
        let old=sqlx::query("SELECT * FROM automatic_reply_inputs WHERE owner_id=? AND source_namespace=? AND source_identity=?")
            .bind(producer.context.owner.to_string()).bind(source_namespace.to_string()).bind(identity).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = old {
            if row.get::<i64, _>("dormant") != 0
                || row.get::<Option<String>, _>("route_id") != Some(producer.route.to_string())
                || row.get::<Option<i64>, _>("route_generation") != Some(producer.generation)
                || row.get::<String, _>("conversation_id") != producer.conversation.to_string()
            {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(AutomaticReplyInputReceipt {
                input_id: row.get::<String, _>("id").parse().map_err(db)?,
                conversation_id: producer.conversation.clone(),
                dormant: false,
                never_replay: false,
            });
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO automatic_reply_inputs(id,owner_id,conversation_id,source_namespace,source_identity,route_id,route_generation,provenance_json,dormant,held) VALUES(?,?,?,?,?,?,?,'{}',0,0)")
            .bind(id.to_string()).bind(producer.context.owner.to_string()).bind(producer.conversation.to_string()).bind(source_namespace.to_string()).bind(identity).bind(producer.route.to_string()).bind(producer.generation).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(AutomaticReplyInputReceipt {
            input_id: id,
            conversation_id: producer.conversation.clone(),
            dormant: false,
            never_replay: false,
        })
    }
    /// Copy-only import. No target route/generation, permission or producer is
    /// created. Historical no_record and sent evidence are both never-replay.
    pub async fn preserve_automatic_reply_input_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        provenance: &AutomaticReplyPreservedInput,
    ) -> Result<AutomaticReplyInputReceipt> {
        if !valid(provenance) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = owner_in(self, &mut tx, credential, conversation).await?;
        if let Some(at) = &provenance.observed_at {
            // Require canonical whole-second UTC and a real calendar instant.
            let normalized: Option<String> =
                sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%SZ',julianday(?))")
                    .bind(at)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if at.len() != 20 || normalized.as_ref() != Some(at) {
                return Err(RuntimeStoreError::InvalidInput);
            }
        }
        let json = serde_json::to_string(provenance).map_err(db)?;
        let old=sqlx::query("SELECT * FROM automatic_reply_inputs WHERE owner_id=? AND source_namespace=? AND source_identity=?")
            .bind(owner.to_string()).bind(provenance.source_namespace.to_string()).bind(&provenance.source_input_identity).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = old {
            if row.get::<i64, _>("dormant") != 1
                || row.get::<String, _>("provenance_json") != json
                || row.get::<String, _>("conversation_id") != conversation.to_string()
            {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(AutomaticReplyInputReceipt {
                input_id: row.get::<String, _>("id").parse().map_err(db)?,
                conversation_id: conversation.clone(),
                dormant: true,
                never_replay: true,
            });
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO automatic_reply_inputs(id,owner_id,conversation_id,source_namespace,source_identity,provenance_json,dormant,held,hold_reason) VALUES(?,?,?,?,?,?,1,1,?)")
            .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(provenance.source_namespace.to_string()).bind(&provenance.source_input_identity).bind(json).bind(serde_json::to_string(&provenance.hold_reason).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(AutomaticReplyInputReceipt {
            input_id: id,
            conversation_id: conversation.clone(),
            dormant: true,
            never_replay: true,
        })
    }
    /// Idempotent negative authority. There is deliberately no release operation.
    pub async fn hold_automatic_reply_input_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: Uuid,
        reason: AutomaticReplyHoldReason,
    ) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = owner_in(self, &mut tx, credential, conversation).await?;
        let row=sqlx::query("SELECT held,hold_reason FROM automatic_reply_inputs WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(input.to_string()).bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        if row.get::<i64, _>("held") == 0 {
            sqlx::query("UPDATE automatic_reply_inputs SET held=1,hold_reason=? WHERE id=?")
                .bind(serde_json::to_string(&reason).map_err(db)?)
                .bind(input.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
