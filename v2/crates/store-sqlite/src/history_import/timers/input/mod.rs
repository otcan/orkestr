//! Requires Core's 0029 registration and generic eligibility fences before exposure.
use super::*;
use orkestr_v2_contracts::{MessageInput, Receipt};

#[derive(Clone, Debug)]
pub struct TimerInputRequest {
    pub claim: TimerClaimRequest,
    /// New target-owner supplied work, never a migrated source prompt.
    pub text: String,
}
#[derive(Clone, Debug)]
pub struct TimerInputReceipt {
    pub claim: TimerClaimReceipt,
    pub input: Receipt,
    pub duplicate: bool,
}
/// Transaction-reported transition status; consumers must not renew grants on replay.
#[derive(Clone, Debug)]
pub struct TimerEnableOutcome {
    pub receipt: TimerReceipt,
    pub duplicate: bool,
}
async fn watermark(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<i64> {
    sqlx::query_scalar("SELECT COALESCE(max(e.sequence),0) FROM production_stop_boundaries b JOIN events e ON e.id=b.event_id WHERE b.owner_id=? AND b.conversation_id=?")
        .bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut **tx).await.map_err(unavailable)
}
pub(super) async fn guard(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    generation: i64,
    conversation: &ConversationId,
) -> Result<()> {
    let stored: Option<i64> = sqlx::query_scalar("SELECT stop_sequence FROM dormant_timer_input_guards WHERE owner_id=? AND namespace=? AND generation=? AND conversation_id=?")
        .bind(owner.to_string()).bind(namespace.to_string()).bind(generation).bind(conversation.to_string()).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    if stored != Some(watermark(tx, owner, conversation).await?) {
        return Err(HistoryError::Conflict);
    }
    Ok(())
}
impl Store {
    /// Explicit owner enable captures the current Deep Stop boundary atomically.
    pub async fn enable_timer_input_outcome(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerEnableRequest,
        now_ms: i64,
    ) -> Result<TimerEnableOutcome> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let result = enable_in_transaction(&mut tx, owner, request, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    /// Compatibility receipt API. Execution controllers need transition status above.
    pub async fn enable_timer_input(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerEnableRequest,
        now_ms: i64,
    ) -> Result<TimerReceipt> {
        Ok(self
            .enable_timer_input_outcome(credential, owner, request, now_ms)
            .await?
            .receipt)
    }
    /// Sole ordinary writer remains Core intake; cadence/provenance/input commit together.
    pub async fn admit_timer_input(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerInputRequest,
        now_ms: i64,
    ) -> Result<TimerInputReceipt> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let result = admit_in_transaction(&mut tx, owner, request, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}

// Shared transaction-local implementation; callers own authentication and commit.
pub(super) async fn enable_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerEnableRequest,
    now_ms: i64,
) -> Result<TimerEnableOutcome> {
    let replay: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_controls WHERE owner_id=? AND namespace=? AND request_key=?").bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.request_key).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let result = control::enable_in_transaction(tx, owner, request, now_ms).await?;
    let boundary = watermark(tx, owner, &request.conversation_id).await?;
    // A replay never refreshes authority across Stop. Existing inert enables
    // cannot be silently promoted into ordinary-input authority either.
    let old: Option<String> = sqlx::query_scalar("SELECT request_key FROM dormant_timer_input_guards WHERE owner_id=? AND namespace=? AND generation=?")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(result.generation).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    if let Some(key) = old {
        if key != request.request_key {
            return Err(HistoryError::Conflict);
        }
        guard(
            tx,
            owner,
            request.namespace,
            result.generation,
            &request.conversation_id,
        )
        .await?;
    } else {
        if replay != 0 {
            return Err(HistoryError::Conflict);
        }
        // A newly enabled generation must not already have occurrences.
        let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims WHERE owner_id=? AND namespace=? AND generation=?")
                .bind(owner.to_string()).bind(request.namespace.to_string()).bind(result.generation).fetch_one(&mut **tx).await.map_err(unavailable)?;
        if claims != 0 {
            return Err(HistoryError::Conflict);
        }
        sqlx::query("INSERT INTO dormant_timer_input_guards(owner_id,namespace,generation,conversation_id,stop_sequence,request_key) VALUES(?,?,?,?,?,?)")
                .bind(owner.to_string()).bind(request.namespace.to_string()).bind(result.generation).bind(request.conversation_id.to_string()).bind(boundary).bind(&request.request_key).execute(&mut **tx).await.map_err(unavailable)?;
    }
    Ok(TimerEnableOutcome {
        receipt: result,
        duplicate: replay != 0,
    })
}
pub(super) async fn admit_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerInputRequest,
    now_ms: i64,
) -> Result<TimerInputReceipt> {
    admit_with(tx, owner, request, now_ms, false).await
}
/// Same admission for a trigger-event occurrence (see `claim::event_in_transaction`).
pub(super) async fn admit_event_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerInputRequest,
    now_ms: i64,
) -> Result<TimerInputReceipt> {
    admit_with(tx, owner, request, now_ms, true).await
}
async fn admit_with(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerInputRequest,
    now_ms: i64,
    event: bool,
) -> Result<TimerInputReceipt> {
    let claim = if event {
        claim::event_in_transaction(tx, owner, &request.claim, now_ms).await?
    } else {
        claim::in_transaction(tx, owner, &request.claim, now_ms).await?
    };
    guard(
        tx,
        owner,
        claim.namespace,
        claim.generation,
        &claim.conversation_id,
    )
    .await?;
    let digest = hash(&request.text);
    let old = sqlx::query("SELECT * FROM dormant_timer_inputs WHERE claim_id=?")
        .bind(claim.claim_id.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?;
    if let Some(ref row) = old {
        if row.get::<String, _>("input_digest") != digest {
            return Err(HistoryError::Conflict);
        }
    }
    let input = MessageInput {
        client_message_id: format!("timer:{}", claim.claim_id),
        text: request.text.clone(),
    };
    let admission = crate::intake::admit_in_transaction(tx, owner, &claim.conversation_id, &input)
        .await
        .map_err(|_| HistoryError::Conflict)?;
    if admission.duplicate != old.is_some() {
        return Err(HistoryError::Conflict);
    }
    let receipt = &admission.receipt;
    if let Some(row) = old {
        if row.get::<String, _>("event_id") != receipt.event_id.to_string()
            || row.get::<String, _>("message_id") != receipt.message_id.to_string()
            || row.get::<i64, _>("scope_sequence") != receipt.sequence
        {
            return Err(HistoryError::Conflict);
        }
    } else {
        sqlx::query("INSERT INTO dormant_timer_inputs(claim_id,owner_id,namespace,generation,input_digest,message_id,event_id,scope_sequence) VALUES(?,?,?,?,?,?,?,?)")
                .bind(claim.claim_id.to_string()).bind(owner.to_string()).bind(claim.namespace.to_string()).bind(claim.generation).bind(digest).bind(receipt.message_id.to_string()).bind(receipt.event_id.to_string()).bind(receipt.sequence).execute(&mut **tx).await.map_err(unavailable)?;
    }
    Ok(TimerInputReceipt {
        claim,
        input: admission.receipt,
        duplicate: admission.duplicate,
    })
}
