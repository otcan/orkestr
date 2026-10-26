//! Trusted scheduler pass: queue target turns, settle outcomes, return them.
use super::*;

/// Per scheduler pass and phase, so one pass stays well below its deadline.
const PASS_LIMIT: i64 = 16;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ThreadAskTick {
    /// Target Deep turns queued for new requests.
    pub queued: u32,
    /// Requests whose outcome became final.
    pub settled: u32,
    /// Outcomes returned to the asking conversation as a new input.
    pub returned: u32,
    /// Items skipped after an item-local refusal; retried on a later pass.
    pub skipped: u32,
}

/// Process-local rotation, never authority: each phase walks request IDs in
/// order and wraps, so stuck rows cannot starve newer ones.
#[derive(Debug, Default, Clone)]
pub struct ThreadAskCursor {
    settle: Option<String>,
    returns: Option<String>,
}

fn next(cursor: &mut Option<String>, page: &[String]) {
    *cursor = if page.len() == PASS_LIMIT as usize {
        page.last().cloned()
    } else {
        None
    };
}
fn local(error: &RuntimeStoreError) -> bool {
    !matches!(
        error,
        RuntimeStoreError::Unauthorized | RuntimeStoreError::Unavailable | RuntimeStoreError::Busy
    )
}

impl Store {
    /// One bounded pass of the trusted local scheduler (same authority as timer
    /// occurrences): queue target turns (only with a window dispatcher), settle
    /// outcomes from Core facts (observed read-only; written only on a real
    /// transition), and return outcomes of ended asking turns as one
    /// attributed input each. Every write commits on its own.
    pub async fn advance_thread_asks(
        &self,
        queue_window: bool,
        cursor: &mut ThreadAskCursor,
    ) -> Result<ThreadAskTick> {
        let context = self.context()?;
        let owner = context.owner.clone();
        let mut tick = ThreadAskTick::default();
        let mut tx = self.pool.begin().await.map_err(db)?;
        context.validate(&mut tx).await?;
        let pending: Vec<String> = if queue_window {
            sqlx::query_scalar("SELECT id FROM thread_asks WHERE owner_id=? AND outcome IS NULL AND window_queued_ms IS NULL ORDER BY created_ms,rowid LIMIT ?")
                .bind(owner.to_string()).bind(PASS_LIMIT).fetch_all(&mut *tx).await.map_err(db)?
        } else {
            Vec::new()
        };
        let open: Vec<String> = sqlx::query_scalar("SELECT id FROM thread_asks WHERE owner_id=? AND outcome IS NULL AND id>? ORDER BY id LIMIT ?")
            .bind(owner.to_string()).bind(cursor.settle.as_deref().unwrap_or("")).bind(PASS_LIMIT)
            .fetch_all(&mut *tx).await.map_err(db)?;
        next(&mut cursor.settle, &open);
        // Decide read-only; only a final decision takes the write lock.
        let mut decided = Vec::new();
        for id in &open {
            let Ok(row) = ask_row(&mut tx, id).await else {
                tick.skipped += 1;
                continue;
            };
            match decision(&mut tx, &row).await {
                Ok(Some(_)) => decided.push(id.clone()),
                Ok(None) => {}
                Err(_) => tick.skipped += 1,
            }
        }
        tx.commit().await.map_err(db)?;
        for id in pending {
            match self.queue_thread_ask(&owner, &id).await {
                Ok(true) => tick.queued += 1,
                Ok(false) => {}
                Err(RuntimeStoreError::Busy) => break,
                Err(error) if local(&error) => tick.skipped += 1,
                Err(error) => return Err(error),
            }
        }
        for id in decided {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            context.validate(&mut tx).await?;
            let settled = match ask_row(&mut tx, &id).await {
                Ok(row) => settle(&mut tx, &row).await,
                Err(error) => Err(error),
            };
            match settled {
                Ok(changed) => {
                    tx.commit().await.map_err(db)?;
                    tick.settled += u32::from(changed);
                }
                // Dropping the transaction rolls this item back only.
                Err(_) => tick.skipped += 1,
            }
        }
        // Listed after settling, so an outcome settled in this pass returns now.
        let mut tx = self.pool.begin().await.map_err(db)?;
        context.validate(&mut tx).await?;
        let ended: Vec<String> = sqlx::query_scalar(&format!("SELECT a.id FROM thread_asks a WHERE a.owner_id=? AND a.outcome IS NOT NULL AND a.return_path IS NULL AND a.id>? AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.id=a.source_run_id AND r.state IN {ACTIVE_RUN}) ORDER BY a.id LIMIT ?"))
            .bind(owner.to_string()).bind(cursor.returns.as_deref().unwrap_or("")).bind(PASS_LIMIT)
            .fetch_all(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        next(&mut cursor.returns, &ended);
        for id in ended {
            match self.return_thread_ask(&owner, &id, queue_window).await {
                Ok(true) => tick.returned += 1,
                Ok(false) => {}
                Err(RuntimeStoreError::Busy) => break,
                Err(error) if local(&error) => tick.skipped += 1,
                Err(error) => return Err(error),
            }
        }
        Ok(tick)
    }

    async fn queue_thread_ask(&self, owner: &OwnerId, id: &str) -> Result<bool> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let row = ask_row(&mut tx, id)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        if row.get::<Option<i64>, _>("window_queued_ms").is_some()
            || row.get::<Option<String>, _>("outcome").is_some()
        {
            return Ok(false);
        }
        let event: String = row.get("input_event_id");
        let elsewhere: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM execution_window_inputs WHERE event_id=?1)+(SELECT count(*) FROM execution_window_queue WHERE event_id=?1)")
            .bind(&event).fetch_one(&mut *tx).await.map_err(db)?;
        let bad = |_| RuntimeStoreError::Unavailable;
        let mut queued = false;
        if elsewhere == 0 {
            match execution_window::enqueue_trusted_intent(
                &mut tx,
                owner,
                &ConversationId(uuid(row.get("target_conversation_id")).map_err(bad)?),
                MessageId(uuid(row.get("input_message_id")).map_err(bad)?),
                EventId(uuid(&event).map_err(bad)?),
                &format!("thread-ask:{id}"),
                format!("thread-ask-window:{event}"),
            )
            .await
            {
                Ok(()) => queued = true,
                Err(RuntimeStoreError::Busy) => return Err(RuntimeStoreError::Busy),
                // Held, retired or already consumed: settlement reports it, and
                // expiry bounds anything Core never resolves.
                Err(RuntimeStoreError::Fenced | RuntimeStoreError::Conflict) => {}
                Err(error) => return Err(error),
            }
        }
        sqlx::query(
            "UPDATE thread_asks SET window_queued_ms=? WHERE id=? AND window_queued_ms IS NULL",
        )
        .bind(now_ms())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(queued)
    }

    async fn return_thread_ask(
        &self,
        owner: &OwnerId,
        id: &str,
        queue_window: bool,
    ) -> Result<bool> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let bad = |_| RuntimeStoreError::Unavailable;
        let row = ask_row(&mut tx, id).await.map_err(bad)?;
        let active: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM production_runs WHERE id=? AND state IN {ACTIVE_RUN}"
        ))
        .bind(row.get::<String, _>("source_run_id"))
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let outcome: Option<String> = row.get("outcome");
        let Some(outcome) = outcome.filter(|_| returned(&row).is_none() && active == 0) else {
            return Ok(false);
        };
        let source = ConversationId(uuid(row.get("source_conversation_id")).map_err(bad)?);
        let target_name = name(&mut tx, row.get("target_conversation_id"))
            .await
            .map_err(bad)?;
        let input = MessageInput {
            client_message_id: format!("thread-ask-reply:{id}"),
            text: reply_text(
                &target_name,
                uuid(id).map_err(bad)?,
                &outcome,
                row.get::<Option<&str>, _>("outcome_detail"),
                row.get::<Option<&str>, _>("answer_text"),
            ),
        };
        let admitted = crate::intake::admit_in_transaction(&mut tx, owner, &source, &input)
            .await
            .map_err(|_| RuntimeStoreError::Conflict)?;
        if admitted.duplicate {
            return Err(RuntimeStoreError::Conflict);
        }
        let changed = sqlx::query("UPDATE thread_asks SET return_path='input',reply_message_id=?,reply_event_id=?,returned_ms=? WHERE id=? AND return_path IS NULL")
            .bind(admitted.receipt.message_id.to_string()).bind(admitted.receipt.event_id.to_string())
            .bind(now_ms()).bind(id)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        if queue_window {
            execution_window::enqueue_trusted_intent(
                &mut tx,
                owner,
                &source,
                admitted.receipt.message_id.clone(),
                admitted.receipt.event_id.clone(),
                &input.client_message_id,
                format!("thread-ask-window:{}", admitted.receipt.event_id.0),
            )
            .await?;
        }
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}
