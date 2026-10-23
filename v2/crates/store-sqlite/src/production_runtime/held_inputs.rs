use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, HeldInputReason, HeldOwnerInput, HeldOwnerInputPage, MessageId, RunId,
};
impl Store {
    /// Fresh current-session read; no release, acknowledgement or setup issuance.
    pub async fn held_owner_inputs_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_sequence: i64,
        limit: u32,
    ) -> Result<HeldOwnerInputPage> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if after_sequence < 0 || !(1..=100).contains(&limit) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(c.owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        c.authenticate(&mut tx).await?;
        c.validate(&mut tx).await?;
        crate::runtime::scope(&mut tx, &c.owner, conversation).await?;
        // Match the actual window claim gate. An old unadmitted input must not
        // spend a one-use native continuation setup for this window.
        let window = c.window_scope(&mut tx).await?;
        if window
            .as_ref()
            .is_some_and(|w| w.get::<String, _>("conversation_id") != conversation.to_string())
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let window_id = window.as_ref().map(|w| w.get::<String, _>("id"));
        let page = projection(
            &mut tx,
            &c.owner,
            conversation,
            after_sequence,
            limit,
            window_id.as_deref(),
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(page)
    }
}

/// Shared immutable projection; callers authenticate their own boundary in this
/// same transaction before entering. Reading a hold never releases inbox input.
async fn projection(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    after_sequence: i64,
    limit: u32,
    window: Option<&str>,
) -> Result<HeldOwnerInputPage> {
    let revision =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(conversation.to_string())
            .fetch_one(&mut **tx)
            .await
            .map_err(db)?;
    let clock = now(tx).await?;
    let eligible:i64=sqlx::query_scalar("SELECT count(*) FROM reasoning_inbox i WHERE i.conversation_id=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) AND (? IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=? AND wi.event_id=i.event_id))")
            .bind(conversation.to_string()).bind(window).bind(window).fetch_one(&mut **tx).await.map_err(db)?;
    let rows=sqlx::query("SELECT h.*,b.run_id,b.through_scope_sequence FROM production_held_inputs h JOIN production_stop_boundaries b ON b.event_id=h.boundary_event_id WHERE h.conversation_id=? AND b.owner_id=? AND h.scope_sequence>? ORDER BY h.scope_sequence LIMIT ?")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(after_sequence).bind(i64::from(limit)+1).fetch_all(&mut **tx).await.map_err(db)?;
    let more = rows.len() > limit as usize;
    let mut held = Vec::new();
    for row in rows.iter().take(limit as usize) {
        held.push(HeldOwnerInput {
            message_id: MessageId(row.get::<String, _>("message_id").parse().map_err(db)?),
            source_event_id: EventId(row.get::<String, _>("event_id").parse().map_err(db)?),
            scope_sequence: row.get("scope_sequence"),
            reason: HeldInputReason::StopBoundary,
            boundary_run_id: RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
            boundary_event_id: EventId(
                row.get::<String, _>("boundary_event_id")
                    .parse()
                    .map_err(db)?,
            ),
            through_scope_sequence: row.get("through_scope_sequence"),
        });
    }
    let next_after_sequence = if more {
        held.last().map(|h| h.scope_sequence)
    } else {
        None
    };
    Ok(HeldOwnerInputPage {
        schema_version: 1,
        conversation_id: conversation.clone(),
        revision,
        observed_at_ms: clock,
        held,
        next_after_sequence,
        eligible_input_available: eligible != 0,
    })
}
mod browser;
#[cfg(test)]
mod browser_tests;
#[cfg(test)]
mod tests;
