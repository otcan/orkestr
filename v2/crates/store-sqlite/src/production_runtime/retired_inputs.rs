//! Owner-only terminal retirement. No run, reply, window or delivery is created.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, MessageId, OwnerInputRetirementReceipt, OwnerInputRetirementRequest,
};

impl Store {
    pub async fn retire_owner_input_for_browser(
        &self,
        credential: &str,
        conversation: &ConversationId,
        message: &MessageId,
        request: &OwnerInputRetirementRequest,
    ) -> Result<OwnerInputRetirementReceipt> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if conversation.0.is_nil() || message.0.is_nil() || !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let owner = OwnerId(owner.parse().map_err(db)?);
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let old = sqlx::query("SELECT message_id,reason,receipt_json FROM owner_input_retirements WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = old {
            if row.get::<String, _>("message_id") != message.to_string()
                || row.get::<String, _>("reason") != request.reason
            {
                return Err(RuntimeStoreError::Conflict);
            }
            let mut receipt: OwnerInputRetirementReceipt =
                serde_json::from_str(row.get("receipt_json")).map_err(db)?;
            receipt.duplicate = true;
            return Ok(receipt);
        }
        let input = inbox_row(&mut tx, &owner, conversation, message)
            .await?
            .ok_or(RuntimeStoreError::NotFound)?;
        let receipt = retire_row(
            &mut tx,
            &owner,
            conversation,
            message,
            &input,
            &request.request_key,
            &request.reason,
        )
        .await?
        .ok_or(RuntimeStoreError::Conflict)?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}

/// What became of an attempt to retire an input inside a larger transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputRetirement {
    /// Retired now: no agent will receive it.
    Retired,
    /// It had already been retired earlier.
    AlreadyRetired,
    /// Claimed, admitted, running or finished: it stays as it is.
    NotRetirable,
}

/// Retire one exact unstarted input in the caller's transaction. Started work
/// is never touched; the caller learns that and tells the agent another way.
pub(crate) async fn retire_if_unstarted(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    message: &MessageId,
    request_key: &str,
    reason: &str,
) -> Result<InputRetirement> {
    let Some(input) = inbox_row(tx, owner, conversation, message).await? else {
        return Ok(InputRetirement::NotRetirable);
    };
    if input.get::<String, _>("state") == "retired" {
        return Ok(InputRetirement::AlreadyRetired);
    }
    Ok(
        match retire_row(
            tx,
            owner,
            conversation,
            message,
            &input,
            request_key,
            reason,
        )
        .await?
        {
            Some(_) => InputRetirement::Retired,
            None => InputRetirement::NotRetirable,
        },
    )
}

/// The exact owner-actor inbox row of `message` in this owner's conversation.
pub(super) async fn inbox_row(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    message: &MessageId,
) -> Result<Option<sqlx::sqlite::SqliteRow>> {
    sqlx::query("SELECT i.* FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id JOIN events e ON e.id=i.event_id AND e.message_id=m.id WHERE i.conversation_id=? AND i.message_id=? AND m.owner_id=? AND m.conversation_id=i.conversation_id AND e.owner_id=m.owner_id AND e.conversation_id=i.conversation_id AND m.actor_kind='owner'")
        .bind(conversation.to_string()).bind(message.to_string()).bind(owner.to_string())
        .fetch_optional(&mut *tx).await.map_err(db)
}

/// The receipt when this exact row was retired; `None` when it has started.
async fn retire_row(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    message: &MessageId,
    input: &sqlx::sqlite::SqliteRow,
    request_key: &str,
    reason: &str,
) -> Result<Option<OwnerInputRetirementReceipt>> {
    let event: String = input.get("event_id");
    // Serialize against claim/admission. Executed or unsettled work refuses.
    // A lone never-dispatched Fast may already have immutable failed-open
    // and lapse evidence; retain that evidence while retiring its input.
    // If retirement wins, state + shared negative authority fence the run.
    let effects: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM production_runs WHERE event_id=?1 OR message_id=?2)+(SELECT count(*) FROM fixture_runs WHERE event_id=?1 OR message_id=?2)+(SELECT count(*) FROM execution_window_inputs i JOIN execution_windows w ON w.id=i.window_id WHERE i.event_id=?1 AND w.state!='closed')+(SELECT count(*) FROM execution_window_queue WHERE event_id=?1 AND state NOT IN ('dispatched','withdrawn'))")
        .bind(&event).bind(message.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
    let no_execution = effects == 0
        || (effects == 1
            && super::failed_fast_setup::retirable_input(tx, owner, conversation, message, &event)
                .await?);
    if input.get::<String, _>("state") != "queued"
        || !no_execution
        || input.get::<Option<String>, _>("admitted_run_id").is_some()
        || input
            .get::<Option<String>, _>("admitted_fixture_run_id")
            .is_some()
    {
        return Ok(None);
    }
    let clock: i64 =
        sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    let receipt = OwnerInputRetirementReceipt {
        retirement_id: Uuid::new_v4(),
        conversation_id: conversation.clone(),
        message_id: message.clone(),
        event_id: orkestr_v2_contracts::EventId(event.parse().map_err(db)?),
        scope_sequence: input.get("sequence"),
        reason: reason.to_owned(),
        state: orkestr_v2_contracts::OwnerInputRetirementState::Retired,
        retired_at_ms: clock,
        duplicate: false,
    };
    sqlx::query("INSERT INTO owner_input_retirements(id,owner_id,conversation_id,message_id,event_id,scope_sequence,request_key,reason,retired_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(receipt.retirement_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(message.to_string()).bind(&event).bind(receipt.scope_sequence)
        .bind(request_key).bind(reason).bind(clock)
        .bind(serde_json::to_string(&receipt).map_err(db)?)
        .execute(&mut *tx).await.map_err(db)?;
    let changed=sqlx::query("UPDATE reasoning_inbox SET state='retired',claimant_session_id=NULL,claim_deadline_ms=NULL WHERE event_id=? AND state='queued'")
        .bind(&event).execute(&mut *tx).await.map_err(db)?.rows_affected();
    if changed != 1 {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(Some(receipt))
}

#[cfg(test)]
pub(super) mod migration_fixture;
#[cfg(test)]
mod tests;
