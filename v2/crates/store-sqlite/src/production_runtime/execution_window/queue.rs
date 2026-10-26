//! Durable owner intent waiting for execution window capacity.
//! Rows never grant execution: Core admission repeats every source predicate
//! and marks a row dispatched in the same transaction that admits its input.
use super::*;
use orkestr_v2_contracts::{
    ExecutionWindowQueued, QueuedWindowState, QueuedWindowWithdrawal, MAX_QUEUED_WINDOW_REQUESTS,
};

fn withdrawal_name(value: QueuedWindowWithdrawal) -> &'static str {
    match value {
        QueuedWindowWithdrawal::InputUnavailable => "input_unavailable",
        QueuedWindowWithdrawal::ReconciliationRequired => "reconciliation_required",
        QueuedWindowWithdrawal::AdmissionRefused => "admission_refused",
    }
}

async fn queued(tx: &mut SqliteConnection, row: &SqliteRow) -> Result<ExecutionWindowQueued> {
    let state = match row.get::<&str, _>("state") {
        "queued" => QueuedWindowState::Queued,
        "dispatched" => QueuedWindowState::Dispatched,
        "withdrawn" => QueuedWindowState::Withdrawn,
        _ => return Err(RuntimeStoreError::Unavailable),
    };
    let withdrawal = match row.get::<Option<&str>, _>("withdrawal") {
        None => None,
        Some("input_unavailable") => Some(QueuedWindowWithdrawal::InputUnavailable),
        Some("reconciliation_required") => Some(QueuedWindowWithdrawal::ReconciliationRequired),
        Some("admission_refused") => Some(QueuedWindowWithdrawal::AdmissionRefused),
        Some(_) => return Err(RuntimeStoreError::Unavailable),
    };
    let position = if state == QueuedWindowState::Queued {
        let ahead: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_queue WHERE owner_id=? AND state='queued' AND position<=?")
            .bind(row.get::<String, _>("owner_id")).bind(row.get::<i64, _>("position"))
            .fetch_one(&mut *tx).await.map_err(db)?;
        Some(u32::try_from(ahead).map_err(db)?)
    } else {
        None
    };
    Ok(ExecutionWindowQueued {
        conversation_id: ConversationId(
            row.get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        ),
        request_key: row.get("request_key"),
        input_message_id: MessageId(row.get::<String, _>("message_id").parse().map_err(db)?),
        input_event_id: EventId(row.get::<String, _>("event_id").parse().map_err(db)?),
        input_request_key: row.get("input_request_key"),
        state,
        position,
        queued_at_ms: row.get("queued_at_ms"),
        window_id: row
            .get::<Option<String>, _>("window_id")
            .map(|id| id.parse().map_err(db))
            .transpose()?,
        withdrawal,
    })
}

async fn by_key(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    key: &str,
) -> Result<Option<SqliteRow>> {
    sqlx::query("SELECT * FROM execution_window_queue WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(key)
        .fetch_optional(tx).await.map_err(db)
}

impl Store {
    /// Durably queue a window intent. Identical retries return the original
    /// row; a changed body or an already admitted key conflicts. Dispatch
    /// rebuilds the window tuple from current state, so a follow-up queued
    /// behind earlier intents keeps its conversation order.
    pub async fn enqueue_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<ExecutionWindowQueued> {
        if !input.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let digest = crate::digest(&serde_json::to_string(input).map_err(db)?);
        if let Some(row) = by_key(&mut tx, &owner, conversation, &input.request_key).await? {
            if row.get::<String, _>("semantic_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = queued(&mut tx, &row).await?;
            tx.commit().await.map_err(db)?;
            return Ok(result);
        }
        let admitted: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_inputs WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key)
            .fetch_one(&mut *tx).await.map_err(db)?;
        let event: i64 =
            sqlx::query_scalar("SELECT count(*) FROM execution_window_queue WHERE event_id=?")
                .bind(input.input_event_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if admitted != 0 || event != 0 {
            return Err(RuntimeStoreError::Conflict);
        }
        admission::source_in(&mut tx, &owner, conversation, input).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM execution_window_queue WHERE owner_id=? AND state='queued'",
        )
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if total >= i64::from(MAX_QUEUED_WINDOW_REQUESTS) {
            return Err(RuntimeStoreError::Busy);
        }
        let clock = now(&mut tx).await?;
        let row = sqlx::query("INSERT INTO execution_window_queue(owner_id,conversation_id,request_key,semantic_digest,message_id,event_id,input_request_key,state,queued_at_ms) VALUES(?,?,?,?,?,?,?,'queued',?) RETURNING *")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key).bind(digest)
            .bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
            .bind(&input.input_request_key).bind(clock)
            .fetch_one(&mut *tx).await.map_err(db)?;
        let result = queued(&mut tx, &row).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Replay lookup before any admission attempt. Read-only evidence.
    pub async fn queued_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<Option<ExecutionWindowQueued>> {
        if !input.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let Some(row) = by_key(&mut tx, &owner, conversation, &input.request_key).await? else {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        };
        let digest = crate::digest(&serde_json::to_string(input).map_err(db)?);
        if row.get::<String, _>("semantic_digest") != digest {
            return Err(RuntimeStoreError::Conflict);
        }
        let result = queued(&mut tx, &row).await?;
        tx.commit().await.map_err(db)?;
        Ok(Some(result))
    }

    /// Queued rows in durable FIFO order, optionally for one conversation.
    pub async fn execution_window_queue_authenticated(
        &self,
        credential: &str,
        conversation: Option<&ConversationId>,
    ) -> Result<Vec<ExecutionWindowQueued>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        if let Some(conversation) = conversation {
            crate::runtime::scope(&mut tx, &owner, conversation).await?;
        }
        let rows = sqlx::query("SELECT * FROM execution_window_queue WHERE owner_id=? AND state='queued' AND (? IS NULL OR conversation_id=?) ORDER BY position LIMIT ?")
            .bind(owner.to_string())
            .bind(conversation.map(|c| c.to_string())).bind(conversation.map(|c| c.to_string()))
            .bind(i64::from(MAX_QUEUED_WINDOW_REQUESTS))
            .fetch_all(&mut *tx).await.map_err(db)?;
        let mut result = Vec::with_capacity(rows.len());
        for row in &rows {
            result.push(queued(&mut tx, row).await?);
        }
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Owner windows that currently hold a manager budget and live processes.
    /// Reconciliation-required or past-deadline windows (for example stuck
    /// awaiting acceptance) block only their own conversation.
    pub async fn live_execution_windows_authenticated(&self, credential: &str) -> Result<u32> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        let clock = now(&mut tx).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE owner_id=? AND state IN ('opening','active','retiring') AND expires_at_ms>?")
            .bind(owner.to_string()).bind(clock).fetch_one(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        u32::try_from(count).map_err(db)
    }

    /// Latest unfinished window of every owner conversation, for cold-start sweep.
    pub async fn unresolved_execution_windows_authenticated(
        &self,
        credential: &str,
    ) -> Result<Vec<ExecutionWindowStatus>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        let rows = sqlx::query("SELECT * FROM execution_windows w WHERE w.owner_id=? AND w.state IN ('opening','active','retiring') AND w.generation=(SELECT max(l.generation) FROM execution_windows l WHERE l.owner_id=w.owner_id AND l.conversation_id=w.conversation_id) ORDER BY w.rowid LIMIT 1024")
            .bind(owner.to_string()).fetch_all(&mut *tx).await.map_err(db)?;
        let result = rows.iter().map(status).collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Withdraw a still-queued row. A dispatched or withdrawn row is unchanged.
    pub async fn withdraw_queued_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        request_key: &str,
        reason: QueuedWindowWithdrawal,
    ) -> Result<ExecutionWindowQueued> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        sqlx::query("UPDATE execution_window_queue SET state='withdrawn',withdrawal=? WHERE owner_id=? AND conversation_id=? AND request_key=? AND state='queued'")
            .bind(withdrawal_name(reason)).bind(owner.to_string()).bind(conversation.to_string()).bind(request_key)
            .execute(&mut *tx).await.map_err(db)?;
        let row = by_key(&mut tx, &owner, conversation, request_key)
            .await?
            .ok_or(RuntimeStoreError::NotFound)?;
        let result = queued(&mut tx, &row).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}

/// Called inside the admission transaction after the input association commits.
pub(super) async fn mark_dispatched(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    input: &ExecutionWindowRequest,
    window: Uuid,
) -> Result<()> {
    sqlx::query("UPDATE execution_window_queue SET state='dispatched',window_id=? WHERE owner_id=? AND event_id=? AND request_key=? AND state='queued'")
        .bind(window.to_string()).bind(owner.to_string())
        .bind(input.input_event_id.to_string()).bind(&input.request_key)
        .execute(tx).await.map_err(db)?;
    Ok(())
}

/// A timer occurrence's queued window intent. Attempt 0 keeps the original
/// `timer-window:<event>` key; each retry after a failed open gets its own
/// key (`…:retry<n>`), so the manager sees a new admission, never a replay of
/// the failed window's request with a different body.
pub(super) fn timer_intent(
    input_message_id: MessageId,
    input_event_id: EventId,
    input_request_key: &str,
    retry: u32,
) -> ExecutionWindowRequest {
    let request_key = match retry {
        0 => format!("timer-window:{}", input_event_id.0),
        n => format!("timer-window:{}:retry{n}", input_event_id.0),
    };
    ExecutionWindowRequest {
        request_key,
        input_message_id,
        input_event_id,
        input_request_key: input_request_key.to_owned(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    }
}

/// Queue the Deep window intent for a timer occurrence inside the trusted timer
/// scheduler transaction that admitted its ordinary input. The owner's durable
/// timer grant is the intent; dispatch still re-authenticates and Core admission
/// repeats every source predicate. A full queue refuses the whole occurrence so
/// it is retried later instead of leaving an input nobody will run.
pub(in crate::production_runtime) async fn enqueue_timer_intent(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    input_message_id: MessageId,
    input_event_id: EventId,
    input_request_key: &str,
) -> Result<()> {
    let key = timer_intent(
        input_message_id.clone(),
        input_event_id.clone(),
        input_request_key,
        0,
    )
    .request_key;
    enqueue_trusted_intent(
        tx,
        owner,
        conversation,
        input_message_id,
        input_event_id,
        input_request_key,
        key,
    )
    .await
}

/// The same durable intent for another trusted scheduler grant (for example a
/// thread-ask input). `request_key` must name the source kind and its event.
pub(in crate::production_runtime) async fn enqueue_trusted_intent(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    input_message_id: MessageId,
    input_event_id: EventId,
    input_request_key: &str,
    request_key: String,
) -> Result<()> {
    let input = ExecutionWindowRequest {
        request_key,
        input_message_id,
        input_event_id,
        input_request_key: input_request_key.to_owned(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    if !input.is_valid() {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let digest = crate::digest(&serde_json::to_string(&input).map_err(db)?);
    if let Some(row) = by_key(tx, owner, conversation, &input.request_key).await? {
        return if row.get::<String, _>("semantic_digest") == digest {
            Ok(())
        } else {
            Err(RuntimeStoreError::Conflict)
        };
    }
    admission::source_in(tx, owner, conversation, &input).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM execution_window_queue WHERE owner_id=? AND state='queued'",
    )
    .bind(owner.to_string())
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if total >= i64::from(MAX_QUEUED_WINDOW_REQUESTS) {
        return Err(RuntimeStoreError::Busy);
    }
    let clock = now(tx).await?;
    sqlx::query("INSERT INTO execution_window_queue(owner_id,conversation_id,request_key,semantic_digest,message_id,event_id,input_request_key,state,queued_at_ms) VALUES(?,?,?,?,?,?,?,'queued',?)")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key).bind(digest)
        .bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
        .bind(&input.input_request_key).bind(clock)
        .execute(&mut *tx).await.map_err(db)?;
    Ok(())
}
