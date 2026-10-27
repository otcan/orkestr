//! Per-conversation timer mapping for the parallel run: import a V1 thread's
//! timers dormant into one owned conversation, list them, and expose the
//! ordinary inputs they produced so a delivery adapter can relay replies.
use super::detail::{detail_in, TimerDetail};
use super::*;

/// Where an imported timer belongs. Recorded once, immutable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimerTarget {
    pub conversation_id: ConversationId,
    pub label: String,
    pub source_thread_id: String,
}
#[derive(Clone, Debug)]
pub struct TimerListing {
    pub detail: TimerDetail,
    pub label: Option<String>,
    pub source_thread_id: Option<String>,
    pub source_namespace: String,
    pub source_timer_id: String,
    /// Enablement in the source system when imported; never V2 enablement.
    pub source_enabled: bool,
    pub policy: super::policy::TimerPolicy,
    pub stats: super::outcome::RunStats,
}
/// One timer occurrence admitted as ordinary owner input. Metadata only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimerInputRecord {
    pub namespace: Uuid,
    pub claim_id: Uuid,
    pub generation: i64,
    pub due_ms: i64,
    pub message_id: String,
    pub event_id: String,
    pub sequence: i64,
    /// The ordinary input request key (`timer:<claim>`), needed to open a window.
    pub request_key: String,
    pub label: Option<String>,
    pub source_timer_id: String,
    /// Cancelled or superseded occurrences are held and will never execute.
    pub held: bool,
    /// Server window intent for this input: queued, dispatched, withdrawn or none.
    pub window: Option<String>,
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
}

/// Dormant import plus immutable conversation mapping inside an authorized
/// write transaction. Replays must repeat the identical mapping.
pub(super) async fn import_for_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &TimerImportRequest,
    target_value: &TimerTarget,
) -> Result<TimerReceipt> {
    if !valid_label(&target_value.label) || !valid(&target_value.source_thread_id, 128) {
        return Err(HistoryError::Invalid);
    }
    target(tx, owner, &target_value.conversation_id).await?;
    let result = import::import_in_transaction(tx, owner, request).await?;
    let existing = sqlx::query(
        "SELECT conversation_id,label,source_thread_id FROM dormant_timer_targets WHERE owner_id=? AND namespace=?",
    )
    .bind(owner.to_string())
    .bind(request.namespace.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    match existing {
        Some(row) => {
            if row.get::<String, _>("conversation_id") != target_value.conversation_id.to_string()
                || row.get::<String, _>("label") != target_value.label
                || row.get::<String, _>("source_thread_id") != target_value.source_thread_id
            {
                return Err(HistoryError::Conflict);
            }
        }
        None => {
            // An unmapped timer already enabled elsewhere cannot be re-homed.
            if result.state != TimerState::Paused {
                return Err(HistoryError::Conflict);
            }
            sqlx::query("INSERT INTO dormant_timer_targets(owner_id,namespace,conversation_id,label,source_thread_id) VALUES(?,?,?,?,?)")
                .bind(owner.to_string()).bind(request.namespace.to_string()).bind(target_value.conversation_id.to_string())
                .bind(&target_value.label).bind(&target_value.source_thread_id)
                .execute(&mut **tx).await.map_err(unavailable)?;
        }
    }
    Ok(result)
}
/// Timers mapped to or enabled in one owned conversation, oldest import first.
pub(super) async fn listings_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<Vec<TimerListing>> {
    target(tx, owner, conversation).await?;
    let rows = sqlx::query("SELECT t.*, g.label AS target_label, g.source_thread_id AS target_thread FROM dormant_timers t LEFT JOIN dormant_timer_targets g ON g.owner_id=t.owner_id AND g.namespace=t.namespace WHERE t.owner_id=? AND (g.conversation_id=? OR t.conversation_id=?) ORDER BY t.rowid LIMIT 500")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(conversation.to_string())
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    let mut result = Vec::with_capacity(rows.len());
    for row in &rows {
        let namespace = Uuid::parse_str(row.get("namespace")).map_err(unavailable)?;
        result.push(TimerListing {
            policy: super::policy::read_in(tx, owner, namespace).await?,
            stats: super::outcome::stats_in(tx, owner, namespace).await?,
            detail: detail_in(tx, owner, row).await?,
            label: row.get("target_label"),
            source_thread_id: row.get("target_thread"),
            source_namespace: row.get("source_namespace"),
            source_timer_id: row.get("source_timer_id"),
            source_enabled: row.get::<i64, _>("source_enabled") == 1,
        });
    }
    Ok(result)
}

impl Store {
    /// Dormant import plus immutable conversation mapping, in one transaction.
    /// Replays must repeat the identical mapping; nothing is enabled here.
    pub async fn import_dormant_timer_for(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &TimerImportRequest,
        target_value: &TimerTarget,
    ) -> Result<TimerReceipt> {
        if !valid_label(&target_value.label) || !valid(&target_value.source_thread_id, 128) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let result = import_for_in(&mut tx, owner, request, target_value).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Timers mapped to or enabled in one owned conversation, oldest import first.
    pub async fn conversation_timers(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Vec<TimerListing>> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let result = listings_in(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Timer-produced ordinary inputs of one conversation after a sequence.
    pub async fn conversation_timer_inputs(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        after_sequence: i64,
        limit: u16,
    ) -> Result<Vec<TimerInputRecord>> {
        if after_sequence < 0 || !(1..=100).contains(&limit) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let rows = sqlx::query("SELECT i.claim_id,i.namespace,i.generation,i.message_id,i.event_id,i.scope_sequence,c.due_ms,m.request_key,t.source_timer_id,g.label,EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) AS held,(SELECT q.state FROM execution_window_queue q WHERE q.event_id=i.event_id) AS window_state,EXISTS(SELECT 1 FROM execution_window_inputs w WHERE w.event_id=i.event_id) AS windowed FROM dormant_timer_inputs i JOIN dormant_timer_claims c ON c.claim_id=i.claim_id JOIN messages m ON m.id=i.message_id JOIN dormant_timers t ON t.owner_id=i.owner_id AND t.namespace=i.namespace LEFT JOIN dormant_timer_targets g ON g.owner_id=i.owner_id AND g.namespace=i.namespace WHERE i.owner_id=? AND c.conversation_id=? AND m.conversation_id=? AND i.scope_sequence>? ORDER BY i.scope_sequence LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(conversation.to_string()).bind(after_sequence).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let parse = |value: String| Uuid::parse_str(&value).map_err(unavailable);
        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let window: Option<String> = row.get("window_state");
            result.push(TimerInputRecord {
                namespace: parse(row.get("namespace"))?,
                claim_id: parse(row.get("claim_id"))?,
                generation: row.get("generation"),
                due_ms: row.get("due_ms"),
                message_id: row.get("message_id"),
                event_id: row.get("event_id"),
                sequence: row.get("scope_sequence"),
                request_key: row.get("request_key"),
                label: row.get("label"),
                source_timer_id: row.get("source_timer_id"),
                held: row.get::<i64, _>("held") == 1,
                window: window.or_else(|| {
                    (row.get::<i64, _>("windowed") == 1).then(|| "dispatched".to_owned())
                }),
            });
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
