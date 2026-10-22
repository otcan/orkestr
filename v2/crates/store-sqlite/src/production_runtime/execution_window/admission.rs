use super::*;
impl Store {
    /// Original browser credential is rechecked inside the same transaction BEFORE replay.
    pub async fn execution_window_status_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionWindowStatus>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let row=sqlx::query("SELECT * FROM execution_windows WHERE owner_id=? AND conversation_id=? ORDER BY generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
        let result = row.as_ref().map(status).transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    /// Single-window admission: any other live owner window refuses as Busy.
    pub async fn admit_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<ExecutionWindowAdmission> {
        self.admit_execution_window_capped_authenticated(credential, conversation, input, 1)
            .await
    }
    /// A new opening is durable BEFORE manager IPC. A receipt is never a native grant.
    /// `capacity` bounds the owner's live (opening/active/retiring) windows across
    /// conversations; each conversation still has at most one unresolved window.
    pub async fn admit_execution_window_capped_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
        capacity: u32,
    ) -> Result<ExecutionWindowAdmission> {
        if !input.is_valid() || capacity == 0 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let digest = crate::digest(&serde_json::to_string(input).map_err(db)?);
        if let Some(row)=sqlx::query("SELECT semantic_digest,receipt_json FROM execution_window_inputs WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("semantic_digest")!=digest { return Err(RuntimeStoreError::Conflict); }
            let mut receipt:ExecutionWindowAdmission=serde_json::from_str(row.get("receipt_json")).map_err(db)?;
            receipt.duplicate=true; tx.commit().await.map_err(db)?; return Ok(receipt);
        }
        source_in(&mut tx, &owner, conversation, input).await?;
        let latest=sqlx::query("SELECT * FROM execution_windows WHERE owner_id=? AND conversation_id=? ORDER BY generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
        let clock = now(&mut tx).await?;
        let current = latest
            .as_ref()
            .map(|r| r.get::<i64, _>("generation") as u64)
            .unwrap_or(0);
        if current != input.expected_generation {
            return Err(RuntimeStoreError::Conflict);
        }
        let row = if let Some(id) = input.window_id {
            let r = latest.ok_or(RuntimeStoreError::NotFound)?;
            if r.get::<String, _>("id") != id.to_string()
                || r.get::<&str, _>("state") != "active"
                || r.get::<i64, _>("work_deadline_ms") <= clock
            {
                return Err(RuntimeStoreError::Fenced);
            }
            r
        } else {
            // Past its hard deadline a window holds no egress or live provider
            // (e.g. stuck awaiting acceptance): it never occupies a slot.
            let other: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE owner_id=? AND conversation_id!=? AND state IN ('opening','active','retiring') AND expires_at_ms>?")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(clock)
                .fetch_one(&mut *tx).await.map_err(db)?;
            if other >= i64::from(capacity) {
                return Err(RuntimeStoreError::Busy);
            }
            match latest.as_ref() {
                None if input.predecessor_window_id.is_none() => {}
                Some(r)
                    if r.get::<&str, _>("state") == "closed"
                        && input.predecessor_window_id.map(|i| i.to_string())
                            == Some(r.get("id")) => {}
                _ => return Err(RuntimeStoreError::Fenced),
            }
            let generation = current
                .checked_add(1)
                .filter(|g| *g < 9_007_199_254_740_992)
                .ok_or(RuntimeStoreError::Unavailable)?;
            sqlx::query("INSERT INTO execution_windows(id,owner_id,conversation_id,generation,state,input_message_id,input_event_id,predecessor_window_id,opened_at_ms,work_deadline_ms,expires_at_ms) VALUES(?,?,?,?,'opening',?,?,?,?,?,?) RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(generation as i64)
                .bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
                .bind(input.predecessor_window_id.map(|i|i.to_string())).bind(clock).bind(clock+870_000).bind(clock+900_000)
                .fetch_one(&mut *tx).await.map_err(db)?
        };
        let receipt = ExecutionWindowAdmission {
            status: status(&row)?,
            input_message_id: input.input_message_id.clone(),
            input_event_id: input.input_event_id.clone(),
            input_request_key: input.input_request_key.clone(),
            request_key: input.request_key.clone(),
            duplicate: false,
        };
        sqlx::query("INSERT INTO execution_window_inputs(owner_id,conversation_id,request_key,semantic_digest,window_id,message_id,event_id,input_request_key,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key).bind(digest)
            .bind(receipt.status.window_id.to_string()).bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
            .bind(&input.input_request_key).bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        super::queue::mark_dispatched(&mut tx, &owner, input, receipt.status.window_id).await?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}

impl Store {
    /// Undo a follow-up's Core join that the window's runtime could not take
    /// over (for example the manager refused it as draining). The input returns
    /// to ordinary admission, so it opens or joins the successor window instead
    /// of waiting, unrunnable, inside this one. `Ok(false)`: a Deep run already
    /// took the input, so it legitimately belongs to this window.
    pub async fn withdraw_unstarted_window_join_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<bool> {
        let Some(window) = input.window_id.filter(|_| input.is_valid()) else {
            return Err(RuntimeStoreError::InvalidInput);
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let digest = crate::digest(&serde_json::to_string(input).map_err(db)?);
        let Some(row) = sqlx::query("SELECT semantic_digest,window_id,event_id FROM execution_window_inputs WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? else {
            tx.commit().await.map_err(db)?;
            return Ok(true);
        };
        if row.get::<String, _>("semantic_digest") != digest
            || row.get::<String, _>("window_id") != window.to_string()
            || row.get::<String, _>("event_id") != input.input_event_id.to_string()
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if !release_unstarted(&mut tx, window, &input.input_event_id.to_string()).await? {
            tx.commit().await.map_err(db)?;
            return Ok(false);
        }
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}

/// Return one window input that no Deep run took (still `queued`, never the
/// window's own opening input) to ordinary admission: drop its window
/// membership and put a dispatched queue intent back in line for the
/// successor. `false` when a run already took it (nothing changes).
pub(super) async fn release_unstarted(
    tx: &mut SqliteConnection,
    window: Uuid,
    event: &str,
) -> Result<bool> {
    let unstarted: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_inputs wi JOIN reasoning_inbox i ON i.event_id=wi.event_id JOIN execution_windows w ON w.id=wi.window_id WHERE wi.window_id=? AND wi.event_id=? AND i.state='queued' AND w.input_event_id!=wi.event_id AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=wi.event_id)")
        .bind(window.to_string()).bind(event).fetch_one(&mut *tx).await.map_err(db)?;
    if unstarted != 1 {
        return Ok(false);
    }
    sqlx::query("DELETE FROM execution_window_inputs WHERE window_id=? AND event_id=?")
        .bind(window.to_string())
        .bind(event)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE execution_window_queue SET state='queued',window_id=NULL WHERE event_id=? AND window_id=? AND state='dispatched'")
        .bind(event).bind(window.to_string()).execute(&mut *tx).await.map_err(db)?;
    Ok(true)
}

pub(super) async fn source_in(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    input: &ExecutionWindowRequest,
) -> Result<()> {
    let source:i64=sqlx::query_scalar("SELECT count(*) FROM messages m JOIN events e ON e.message_id=m.id JOIN reasoning_inbox i ON i.event_id=e.id AND i.message_id=m.id WHERE m.id=? AND e.id=? AND m.owner_id=? AND m.conversation_id=? AND e.owner_id=m.owner_id AND e.conversation_id=m.conversation_id AND m.actor_kind='owner' AND m.request_key=? AND i.state='queued' AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=e.id) AND NOT EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.event_id=e.id)")
        .bind(input.input_message_id.to_string()).bind(input.input_event_id.to_string())
        .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.input_request_key)
        .fetch_one(tx).await.map_err(db)?;
    if source != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
