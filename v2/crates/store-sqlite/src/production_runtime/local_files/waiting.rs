//! Owner-wide list of local folder writes waiting for the owner (ORK-804),
//! so every tab and device can say that a write waits and where to allow it.
//! Since ORK-810 the current UI applies writes on its own and no longer reads
//! this list; it stays for UI releases before that (a tab still open on one
//! asks for Allow), and the count is capped where those releases expect it.
//! A read only: `settle`'s time-driven transitions are not written here; the
//! same conditions are applied in the query (an unexpired write and a tab
//! that polled within the connection lifetime), so a write `settle` would
//! fail is never listed.
use super::*;
use orkestr_v2_contracts::{
    LocalFileWriteWaiting, LocalFileWritesWaiting, LOCAL_FILE_OPEN_MAX, LOCAL_FILE_WAITING_MAX,
    LOCAL_FILE_WAITING_NAME_MAX,
};

/// Driven by the few live connections; each probes the open-request index.
const WAITING: &str = "SELECT c.conversation_id,c.folder_name,d.name,count(*) AS writes,
 min(r.deadline_ms) AS deadline_ms,min(r.created_ms) AS first_ms
 FROM local_file_connections c
 JOIN local_file_requests r ON r.conversation_id=c.conversation_id AND r.owner_id=c.owner_id
 LEFT JOIN conversation_directory d ON d.conversation_id=c.conversation_id AND d.owner_id=c.owner_id
 WHERE c.owner_id=?1 AND c.seen_ms>?2-?3
  AND r.operation='write' AND r.state IN ('queued','working') AND r.deadline_ms>?2
 GROUP BY c.conversation_id,c.folder_name,d.name
 ORDER BY first_ms,c.conversation_id LIMIT ?4";

fn display(name: Option<String>) -> String {
    let name: String = name
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(LOCAL_FILE_WAITING_NAME_MAX)
        .collect();
    match name.trim() {
        "" => "Conversation".into(),
        name => name.into(),
    }
}

impl Store {
    /// Conversations of the owner whose agent queued a write that waits for
    /// the owner's Allow in the connected folder tab. Readable with the
    /// owner's browser, machine or live service session.
    pub async fn local_file_writes_waiting(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> R<LocalFileWritesWaiting> {
        let now = now_ms();
        let mut tx = self
            .local_files_session(credential, owner, None, false, OWNER_KINDS)
            .await?;
        let rows = sqlx::query(WAITING)
            .bind(owner.to_string())
            .bind(now)
            .bind(LOCAL_FILE_CONNECTION_TTL_MS)
            .bind(LOCAL_FILE_WAITING_MAX as i64)
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let conversations = rows
            .iter()
            .map(|row| {
                Ok(LocalFileWriteWaiting {
                    conversation_id: ConversationId(uuid(row.get("conversation_id"))?),
                    conversation_name: display(row.get("name")),
                    folder_name: row.get("folder_name"),
                    // A queue may now be deeper than older UIs accept.
                    writes: u32::try_from(row.get::<i64, _>("writes").min(LOCAL_FILE_OPEN_MAX))
                        .map_err(unavailable)?,
                    deadline_ms: row.get("deadline_ms"),
                })
            })
            .collect::<R<Vec<_>>>()?;
        Ok(LocalFileWritesWaiting { conversations })
    }
}

#[cfg(test)]
#[path = "waiting_tests.rs"]
mod tests;
