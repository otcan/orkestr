//! Trusted source identity for a new decision. No adapter-side Core SQL.
use super::*;

impl Store {
    pub async fn source_context(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        query: &SourceContextQuery,
    ) -> Result<SourceContextProof> {
        if query.source_run_id.0.is_nil() || query.source_message_id.0.is_nil() {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let valid:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if valid != 1 {
            return Err(StoreError::NotFound);
        }
        let row=sqlx::query("SELECT r.native_session_id,r.provider_kind,r.binding_generation,COALESCE(s.provider_generation,0) AS provider_generation FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id AND b.role='deep' LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.message_id=? AND r.role='deep'")
            .bind(query.source_run_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(query.source_message_id.to_string()).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(StoreError::NotFound)?;
        let eligible =
            source_binding_is_current(&mut tx, owner, conversation, &query.source_run_id).await?;
        let proof = SourceContextProof {
            schema_version: 1,
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            source_run_id: query.source_run_id.clone(),
            source_message_id: query.source_message_id.clone(),
            source_native_session_id: row.get("native_session_id"),
            source_provider: crate::source_receipts::provider(row.get("provider_kind"))?,
            provider_generation: row.get("provider_generation"),
            binding_generation: row.get("binding_generation"),
            eligible_for_continuation: eligible,
        };
        tx.commit().await.map_err(db)?;
        Ok(proof)
    }
}

/// Acceptance releases the exact occupied binding and advances its generation
/// once in the same transaction. Only that recorded completion can explain a
/// ready binding one generation ahead; reuse, replacement or retirement cannot.
pub(super) async fn source_binding_is_current(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
) -> Result<bool> {
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep' AND b.role='deep' AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND r.provider_kind=COALESCE(s.provider,'codex') AND ((b.state='busy' AND b.generation=r.binding_generation) OR (b.state='ready' AND b.generation=r.binding_generation+1 AND r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.conversation_id=r.conversation_id))) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation)")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok(valid == 1)
}

/// A Deep run cut by a Root-recorded release interruption (ORK-792): Stop
/// cancelled it and released its binding to `ready` one generation ahead, so
/// `source_binding_is_current` refuses its continuation. The server presents a
/// grant only for an unexpired Root record naming this exact run, conversation
/// and provider generation. Exactly one continuation: the first admission's
/// fence consumes it, and any later run on the same native session refuses it.
/// `holder` is None at admission (no fence may exist yet) and the admitted
/// message at its own dispatch-time revalidation (it must hold the only fence).
pub struct ReleasedContinuation {
    pub source_run_id: orkestr_v2_contracts::RunId,
    pub provider_generation: i64,
}

pub(super) async fn source_binding_released_once(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
    holder: Option<&orkestr_v2_contracts::MessageId>,
) -> Result<bool> {
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep' AND r.state='cancelled' AND b.role='deep' AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND r.provider_kind=COALESCE(s.provider,'codex') AND b.state='ready' AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM source_admission_fences f WHERE f.source_run_id=r.id AND f.message_id<>?)")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(holder.map(|m| m.to_string()).unwrap_or_default())
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok(valid == 1)
}
