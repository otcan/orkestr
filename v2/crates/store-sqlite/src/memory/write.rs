use super::*;
impl Store {
    /// Explicit owner decision over an exact transient proposal. Auth/enable are
    /// checked inside the write transaction before even historical receipt replay.
    pub async fn save_memory_authenticated(
        &self,
        credential: &str,
        proposal: &MemoryProposal,
        decision: &MemoryOwnerDecision,
    ) -> Result<MemoryReceipt> {
        let (mut tx, owner) = self.memory_transaction(credential, true, true).await?;
        let mut operation = proposal.operation.clone();
        validation::normalize(&mut operation)?;
        if proposal.schema_version != 1
            || !validation::key(&proposal.request_key, 128)
            || operation != proposal.operation
            || validation::proposal_digest(&proposal.request_key, &operation)? != proposal.digest
        {
            return Err(MemoryError::Invalid);
        }
        let trust = validation::consent(proposal, decision)?;
        let action = match decision.action {
            MemoryConsentAction::Remember => "remember",
            MemoryConsentAction::Approve => "approve",
            MemoryConsentAction::Correct => "correct",
            MemoryConsentAction::Forget => "forget",
        };
        let old=sqlx::query("SELECT proposal_digest,action,memory_id,revision,forgotten FROM memory_decisions WHERE owner_id=? AND request_key=?")
            .bind(owner.to_string()).bind(&proposal.request_key).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = old {
            if row.get::<String, _>("proposal_digest") != proposal.digest
                || row.get::<String, _>("action") != action
            {
                return Err(MemoryError::Conflict);
            }
            let receipt = MemoryReceipt {
                memory_id: row.get::<String, _>("memory_id").parse().map_err(db)?,
                revision: row.get::<i64, _>("revision") as u64,
                forgotten: row.get::<i64, _>("forgotten") == 1,
            };
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        validation::validate_operation(&mut tx, &owner, &operation).await?;
        let now: i64 = sqlx::query_scalar("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let (id, revision, forgotten) = match &operation {
            MemoryOperation::Create { candidate } => {
                let n: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM memory_records WHERE owner_id=?")
                        .bind(owner.to_string())
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(db)?;
                if n >= 5000 {
                    return Err(MemoryError::Limit);
                }
                let id = Uuid::new_v4();
                let project = match &candidate.scope {
                    MemoryScope::Owner => None,
                    MemoryScope::Project { project_id } => Some(project_id.to_string()),
                };
                sqlx::query("INSERT INTO memory_records(id,owner_id,project_id,revision,candidate_json,trust,consented_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)")
                    .bind(id.to_string()).bind(owner.to_string()).bind(project).bind(serde_json::to_string(candidate).map_err(db)?)
                    .bind(trust_text(trust)).bind(now).bind(now).execute(&mut *tx).await.map_err(db)?;
                (id, 1, false)
            }
            MemoryOperation::Correct {
                memory_id,
                expected_revision,
                candidate,
            } => {
                let changed=sqlx::query("UPDATE memory_records SET revision=revision+1,candidate_json=?,trust=?,consented_at_ms=?,updated_at_ms=? WHERE id=? AND owner_id=? AND revision=?")
                    .bind(serde_json::to_string(candidate).map_err(db)?).bind(trust_text(trust)).bind(now).bind(now)
                    .bind(memory_id.to_string()).bind(owner.to_string()).bind(*expected_revision as i64).execute(&mut *tx).await.map_err(db)?.rows_affected();
                if changed != 1 {
                    return Err(MemoryError::Conflict);
                }
                (*memory_id, expected_revision + 1, false)
            }
            MemoryOperation::Forget {
                memory_id,
                expected_revision,
            } => {
                let changed = sqlx::query(
                    "DELETE FROM memory_records WHERE id=? AND owner_id=? AND revision=?",
                )
                .bind(memory_id.to_string())
                .bind(owner.to_string())
                .bind(*expected_revision as i64)
                .execute(&mut *tx)
                .await
                .map_err(db)?
                .rows_affected();
                if changed != 1 {
                    return Err(MemoryError::Conflict);
                }
                (*memory_id, expected_revision + 1, true)
            }
        };
        sqlx::query("INSERT INTO memory_decisions(owner_id,request_key,proposal_digest,action,memory_id,revision,forgotten) VALUES(?,?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(&proposal.request_key).bind(&proposal.digest).bind(action).bind(id.to_string())
            .bind(revision as i64).bind(forgotten as i64).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(MemoryReceipt {
            memory_id: id,
            revision,
            forgotten,
        })
    }
}
fn trust_text(t: MemoryTrust) -> &'static str {
    match t {
        MemoryTrust::OwnerAuthored => "owner_authored",
        MemoryTrust::OwnerConfirmed => "owner_confirmed",
    }
}
