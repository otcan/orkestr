//! Owner sidebar observations: per-conversation activity, preview and unread
//! counts, forward-only read marks and write-once V1 lineage. Reads never
//! sweep, reconcile or admit anything.
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::{
    ConversationId, ConversationLineage, OwnerId, SidebarAuthor, SidebarKey, SIDEBAR_MAX_ENTRIES,
};
use sqlx::{Row, Sqlite, Transaction};

type Result<T> = std::result::Result<T, ResourceError>;

/// One native conversation as the sidebar needs it. Timestamps stay the exact
/// stored strings (`events.occurred_at`, archived `created_at`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarConversation {
    pub conversation_id: ConversationId,
    pub name: String,
    pub sequence: i64,
    pub last_event_at: Option<String>,
    pub last_archived_at: Option<String>,
    /// Accepted replies after max(read mark, the owner's latest message).
    pub unread: u32,
    pub preview: Option<(SidebarAuthor, String)>,
    /// First archived source thread (the V1 thread it was imported from), or
    /// the V1 group thread created for it by "New WhatsApp chat".
    pub source_thread_id: Option<String>,
    pub lineage: Option<ConversationLineage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarConversations {
    pub conversations: Vec<SidebarConversation>,
    pub truncated: bool,
    /// `v1:<thread>` marks, keyed by thread id.
    pub v1_marks: std::collections::BTreeMap<String, i64>,
}

const LIST: &str = "SELECT d.conversation_id,d.name,c.sequence,
 (SELECT max(e.occurred_at) FROM events e WHERE e.conversation_id=d.conversation_id AND e.owner_id=d.owner_id) AS last_event_at,
 (SELECT m.created_at FROM archived_history_messages m JOIN archived_history_sources s ON s.row_sequence=m.source_row
   WHERE s.conversation_id=d.conversation_id AND s.owner_id=d.owner_id AND m.created_at IS NOT NULL
   ORDER BY m.created_at DESC LIMIT 1) AS last_archived_at,
 (SELECT count(*) FROM events e WHERE e.conversation_id=d.conversation_id AND e.owner_id=d.owner_id AND e.kind='execution_accepted'
   AND e.sequence>max(
     coalesce((SELECT r.marker FROM sidebar_read_marks r WHERE r.owner_id=d.owner_id AND r.entry_key='v2:'||d.conversation_id),0),
     coalesce((SELECT max(o.sequence) FROM messages o WHERE o.conversation_id=d.conversation_id AND o.owner_id=d.owner_id),0))) AS unread,
 coalesce((SELECT s.source_thread_id FROM archived_history_sources s WHERE s.conversation_id=d.conversation_id AND s.owner_id=d.owner_id
   ORDER BY s.row_sequence LIMIT 1),
  (SELECT p.v1_thread_id FROM whatsapp_chat_provisions p WHERE p.owner_id=d.owner_id AND p.conversation_id=d.conversation_id)) AS source_thread_id,
 l.source_instance AS lineage_instance,l.source_thread_id AS lineage_thread,l.source_parent_thread_id AS lineage_parent
 FROM conversation_directory d
 JOIN conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id
 LEFT JOIN conversation_lineage l ON l.owner_id=d.owner_id AND l.conversation_id=d.conversation_id
 WHERE d.owner_id=? ORDER BY d.row_sequence LIMIT ?";

/// Latest owner message or accepted reply; the reply text is the last
/// progress payload before completion, as accepted results present it.
const NATIVE_PREVIEW: &str = "SELECT e.kind,m.text AS owner_text,
 (SELECT p.text FROM production_acceptances a JOIN production_payloads p ON p.run_id=a.run_id AND p.owner_id=a.owner_id
   JOIN production_observations o ON o.event_id=p.event_id AND o.kind='progress'
   WHERE a.event_id=e.id ORDER BY o.run_sequence DESC LIMIT 1) AS reply_text
 FROM events e LEFT JOIN messages m ON m.id=e.message_id AND m.owner_id=e.owner_id
 WHERE e.conversation_id=? AND e.owner_id=? AND e.kind IN ('message_accepted','execution_accepted')
 ORDER BY e.sequence DESC LIMIT 1";

const ARCHIVED_PREVIEW: &str = "SELECT m.role,m.text FROM archived_history_messages m
 JOIN archived_history_sources s ON s.row_sequence=m.source_row
 WHERE s.conversation_id=? AND s.owner_id=? ORDER BY s.row_sequence DESC,m.source_position DESC LIMIT 1";

async fn session(
    tx: &mut Transaction<'_, Sqlite>,
    credential: &str,
    owner: &OwnerId,
) -> Result<()> {
    let sessions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
    )
    .bind(crate::digest(credential))
    .bind(owner.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)?;
    if sessions == 1 {
        Ok(())
    } else {
        Err(ResourceError::Unauthorized)
    }
}

impl Store {
    async fn sidebar_scope(
        &self,
        credential: &str,
        owner: &OwnerId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        session(&mut tx, credential, owner).await?;
        Ok(tx)
    }

    /// Every directory conversation of the owner (bounded), in one read
    /// transaction, plus the owner's V1 read marks.
    pub async fn sidebar_conversations(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<SidebarConversations> {
        let mut tx = self.sidebar_scope(credential, owner, false).await?;
        let owner_id = owner.to_string();
        let mut rows = sqlx::query(LIST)
            .bind(&owner_id)
            .bind(SIDEBAR_MAX_ENTRIES as i64 + 1)
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        let truncated = rows.len() > SIDEBAR_MAX_ENTRIES;
        rows.truncate(SIDEBAR_MAX_ENTRIES);
        let mut conversations = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("conversation_id");
            let conversation_id = ConversationId(id.parse().map_err(unavailable)?);
            let preview = match sqlx::query(NATIVE_PREVIEW)
                .bind(&id)
                .bind(&owner_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?
            {
                Some(p) if p.get::<String, _>("kind") == "message_accepted" => p
                    .get::<Option<String>, _>("owner_text")
                    .map(|t| (SidebarAuthor::Owner, t)),
                Some(p) => p
                    .get::<Option<String>, _>("reply_text")
                    .map(|t| (SidebarAuthor::Assistant, t)),
                None => sqlx::query(ARCHIVED_PREVIEW)
                    .bind(&id)
                    .bind(&owner_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(unavailable)?
                    .map(|p| {
                        let author = match p.get::<String, _>("role").as_str() {
                            "user" | "owner" => SidebarAuthor::Owner,
                            _ => SidebarAuthor::Assistant,
                        };
                        (author, p.get::<String, _>("text"))
                    }),
            };
            let lineage = row
                .get::<Option<String>, _>("lineage_instance")
                .map(|source_instance| ConversationLineage {
                    source_instance,
                    source_thread_id: row.get("lineage_thread"),
                    source_parent_thread_id: row.get("lineage_parent"),
                });
            conversations.push(SidebarConversation {
                conversation_id,
                name: row.get("name"),
                sequence: row.get("sequence"),
                last_event_at: row.get("last_event_at"),
                last_archived_at: row.get("last_archived_at"),
                unread: u32::try_from(row.get::<i64, _>("unread")).unwrap_or(u32::MAX),
                preview,
                source_thread_id: row.get("source_thread_id"),
                lineage,
            });
        }
        let marks = sqlx::query(
            "SELECT substr(entry_key,4) AS thread,marker FROM sidebar_read_marks WHERE owner_id=? AND entry_key LIKE 'v1:%'",
        )
        .bind(&owner_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let v1_marks = marks
            .iter()
            .map(|r| (r.get::<String, _>("thread"), r.get::<i64, _>("marker")))
            .collect();
        tx.commit().await.map_err(unavailable)?;
        Ok(SidebarConversations {
            conversations,
            truncated,
            v1_marks,
        })
    }

    /// Forward-only read mark. A native mark is bounded by the conversation's
    /// current sequence; an older mark than the stored one is a no-op.
    pub async fn mark_sidebar_read(
        &self,
        credential: &str,
        owner: &OwnerId,
        key: &SidebarKey,
        marker: i64,
    ) -> Result<i64> {
        if marker < 0 {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.sidebar_scope(credential, owner, true).await?;
        if let SidebarKey::V2(conversation) = key {
            crate::conversation_resources::owned(&mut tx, owner, conversation).await?;
            let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
            if marker > sequence {
                return Err(ResourceError::Invalid);
            }
        }
        sqlx::query(
            "INSERT INTO sidebar_read_marks(owner_id,entry_key,marker,updated_at_ms) VALUES(?,?,?,?)
             ON CONFLICT(owner_id,entry_key) DO UPDATE SET marker=excluded.marker,updated_at_ms=excluded.updated_at_ms
             WHERE excluded.marker>sidebar_read_marks.marker",
        )
        .bind(owner.to_string())
        .bind(key.to_string())
        .bind(marker)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let stored: i64 = sqlx::query_scalar(
            "SELECT marker FROM sidebar_read_marks WHERE owner_id=? AND entry_key=?",
        )
        .bind(owner.to_string())
        .bind(key.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(stored)
    }

    /// Records where an imported conversation came from. The source must be
    /// one of the conversation's archived history sources. Identical replays
    /// return `false`; a different lineage is a conflict, never an overwrite.
    pub async fn record_conversation_lineage(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        lineage: &ConversationLineage,
    ) -> Result<bool> {
        if !lineage.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let existing = sqlx::query(
            "SELECT source_instance,source_thread_id,source_parent_thread_id FROM conversation_lineage WHERE owner_id=? AND conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some(row) = existing {
            let same = ConversationLineage {
                source_instance: row.get("source_instance"),
                source_thread_id: row.get("source_thread_id"),
                source_parent_thread_id: row.get("source_parent_thread_id"),
            } == *lineage;
            tx.commit().await.map_err(unavailable)?;
            return if same {
                Ok(false)
            } else {
                Err(ResourceError::Conflict("lineage_conflict"))
            };
        }
        let sources: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM archived_history_sources WHERE owner_id=? AND conversation_id=? AND source_instance=? AND source_thread_id=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(&lineage.source_instance)
        .bind(&lineage.source_thread_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if sources != 1 {
            return Err(ResourceError::Conflict("lineage_source_not_imported"));
        }
        sqlx::query("INSERT INTO conversation_lineage(owner_id,conversation_id,source_instance,source_thread_id,source_parent_thread_id,recorded_at_ms) VALUES(?,?,?,?,?,?)")
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .bind(&lineage.source_instance)
            .bind(&lineage.source_thread_id)
            .bind(&lineage.source_parent_thread_id)
            .bind(now_ms())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(true)
    }
}

#[cfg(test)]
#[path = "sidebar_tests.rs"]
mod tests;
