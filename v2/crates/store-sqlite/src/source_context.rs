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
///
/// ORK-843: a run is also still current while its session has only continued
/// it. A turn may file several host requests and end; the first result starts
/// a follow-up turn fenced to that same run, and a later result of the same
/// turn used to be refused as "moved on" by that follow-up. So the source run
/// R stays current when R succeeded and was accepted, every later run on its
/// session took as its input a message fenced to R (under the provider
/// generation that is still current), and the latest of those runs meets the
/// rule above on the same binding, native session and provider. Any other
/// later run (an owner message, a timer firing, a continuation of another
/// run) still ends R's continuations, and so does a retired, reset or
/// replaced binding.
pub(super) async fn source_binding_is_current(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
) -> Result<bool> {
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep' AND b.role='deep' AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND r.provider_kind=COALESCE(s.provider,'codex') AND ((b.state='busy' AND b.generation=r.binding_generation) OR (b.state='ready' AND b.generation=r.binding_generation+1 AND r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.conversation_id=r.conversation_id))) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation)")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(&mut *tx).await.map_err(db)?;
    if valid == 1 {
        return Ok(true);
    }
    source_binding_only_continued(tx, owner, conversation, run).await
}

/// ORK-843: `r` is the source run and `l` the latest later run on its
/// session. `l` must be fenced to `r`, be the only run at or above its own
/// generation, and hold the binding exactly as the rule above requires of a
/// current run; no later run may lack a fence to `r` under the current
/// provider generation.
async fn source_binding_only_continued(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
) -> Result<bool> {
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id JOIN production_runs l ON l.session_id=r.session_id AND l.owner_id=r.owner_id AND l.conversation_id=r.conversation_id AND l.id!=r.id AND l.binding_generation>r.binding_generation JOIN source_admission_fences lf ON lf.message_id=l.message_id AND lf.source_run_id=r.id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep' AND l.role='deep' AND b.role='deep' AND r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.conversation_id=r.conversation_id) AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND r.provider_kind=COALESCE(s.provider,'codex') AND l.provider_kind=r.provider_kind AND l.native_session_id=r.native_session_id AND lf.expected_provider_generation=COALESCE(s.provider_generation,0) AND ((b.state='busy' AND b.generation=l.binding_generation) OR (b.state='ready' AND b.generation=l.binding_generation+1 AND l.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=l.id AND a.owner_id=l.owner_id AND a.conversation_id=l.conversation_id))) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=l.id AND other.binding_generation>=l.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation AND NOT EXISTS(SELECT 1 FROM source_admission_fences f WHERE f.message_id=other.message_id AND f.source_run_id=r.id AND f.expected_provider_generation=COALESCE(s.provider_generation,0)))")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok(valid == 1)
}

/// A Deep run cut by a Root-recorded release interruption (ORK-792): Stop
/// cancelled it and released its binding to `ready` one generation ahead, so
/// `source_binding_is_current` refuses its continuation. The server presents a
/// grant only for an unexpired Root record naming this exact run, conversation
/// and provider generation. Exactly one continuation after the cut: the first
/// admission's fence consumes it, and any later run on the same native session
/// refuses it. Fences admitted while the run was still live (a host tool's
/// result, admitted while its binding was busy) are ordinary continuations of
/// that live run: they neither consume the release continuation nor dispatch
/// through it. "After the cut" means a message sequence above the run's
/// terminal evidence event; a run without terminal evidence keeps the strict
/// rule (every fence counts).
/// `holder` is None at admission (no post-cut fence may exist yet) and the
/// admitted message at its own dispatch-time revalidation (it must be the
/// only post-cut fence, itself admitted after the cut).
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
    let holder = holder.map(|m| m.to_string()).unwrap_or_default();
    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id AND b.owner_id=r.owner_id AND b.conversation_id=r.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=r.owner_id AND s.conversation_id=r.conversation_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep' AND r.state='cancelled' AND b.role='deep' AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND r.provider_kind=COALESCE(s.provider,'codex') AND b.state='ready' AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM source_admission_fences f JOIN messages m ON m.id=f.message_id WHERE f.source_run_id=r.id AND f.message_id<>? AND m.sequence>COALESCE((SELECT max(e.sequence) FROM production_terminal_evidence t JOIN events e ON e.id=t.event_id WHERE t.run_id=r.id),-1)) AND (?='' OR EXISTS(SELECT 1 FROM messages h WHERE h.id=? AND h.owner_id=r.owner_id AND h.conversation_id=r.conversation_id AND h.sequence>COALESCE((SELECT max(e.sequence) FROM production_terminal_evidence t JOIN events e ON e.id=t.event_id WHERE t.run_id=r.id),-1)))")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(&holder).bind(&holder).bind(&holder)
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok(valid == 1)
}
