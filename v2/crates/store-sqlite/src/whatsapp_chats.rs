//! Durable records of "New WhatsApp chat" provisions (migration 0058). One row
//! per owner request: identity fixed at insert, stages only move forward, rows
//! retained. Writes never admit input or start execution.
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::{
    ConversationId, OwnerId, WhatsAppChatProvision, WhatsAppChatStage, WHATSAPP_CHAT_LIST_MAX,
};
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ResourceError>;

/// The fixed identity of a new provision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhatsAppChatIdentity {
    pub request_key: String,
    pub conversation_id: ConversationId,
    pub name: String,
    pub v1_thread_id: String,
    pub remote_thread_id: String,
    pub workspace: Option<String>,
}

const COLUMNS: &str = "request_key,conversation_id,name,v1_thread_id,remote_thread_id,workspace,chat_id,stage,last_error,archived,created_at_ms,updated_at_ms";

fn provision(row: &SqliteRow) -> Result<WhatsAppChatProvision> {
    let conversation = row
        .try_get::<String, _>("conversation_id")
        .ok()
        .and_then(|id| Uuid::parse_str(&id).ok())
        .ok_or(ResourceError::Unavailable)?;
    let value = WhatsAppChatProvision {
        client_request_id: row.try_get("request_key").map_err(unavailable)?,
        conversation_id: ConversationId(conversation),
        name: row.try_get("name").map_err(unavailable)?,
        v1_thread_id: row.try_get("v1_thread_id").map_err(unavailable)?,
        remote_thread_id: row.try_get("remote_thread_id").map_err(unavailable)?,
        workspace: row.try_get("workspace").map_err(unavailable)?,
        chat_id: row.try_get("chat_id").map_err(unavailable)?,
        stage: WhatsAppChatStage::from_index(row.try_get("stage").map_err(unavailable)?)
            .ok_or(ResourceError::Unavailable)?,
        error: row.try_get("last_error").map_err(unavailable)?,
        archived: row.try_get::<i64, _>("archived").map_err(unavailable)? == 1,
        created_at_ms: row.try_get("created_at_ms").map_err(unavailable)?,
        updated_at_ms: row.try_get("updated_at_ms").map_err(unavailable)?,
    };
    value
        .is_valid()
        .then_some(value)
        .ok_or(ResourceError::Unavailable)
}

impl Store {
    async fn whatsapp_chat_scope(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let sessions: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if sessions != 1 {
            return Err(ResourceError::Unauthorized);
        }
        Ok(tx)
    }

    async fn whatsapp_chat_row(
        tx: &mut Transaction<'_, Sqlite>,
        owner: &OwnerId,
        request_key: &str,
    ) -> Result<Option<WhatsAppChatProvision>> {
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM whatsapp_chat_provisions WHERE owner_id=? AND request_key=?"
        ))
        .bind(owner.to_string())
        .bind(request_key)
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?;
        row.as_ref().map(provision).transpose()
    }

    /// Records a new provision at stage `conversation`, or returns the
    /// existing one for the same key (with its original V1 thread and route
    /// ids). Another conversation, name or workspace under the same key is
    /// `whatsapp_chat_conflict`.
    pub async fn begin_whatsapp_chat(
        &self,
        credential: &str,
        owner: &OwnerId,
        identity: &WhatsAppChatIdentity,
    ) -> Result<WhatsAppChatProvision> {
        let mut tx = self.whatsapp_chat_scope(credential, owner).await?;
        if let Some(existing) =
            Self::whatsapp_chat_row(&mut tx, owner, &identity.request_key).await?
        {
            // The V1 thread and route ids were chosen by the first request;
            // a retry continues with them.
            let same = existing.conversation_id == identity.conversation_id
                && existing.name == identity.name
                && existing.workspace == identity.workspace;
            tx.commit().await.map_err(unavailable)?;
            return if same {
                Ok(existing)
            } else {
                Err(ResourceError::Conflict("whatsapp_chat_conflict"))
            };
        }
        let now = now_ms();
        let inserted = sqlx::query(
            "INSERT INTO whatsapp_chat_provisions(owner_id,request_key,conversation_id,name,v1_thread_id,remote_thread_id,workspace,stage,created_at_ms,updated_at_ms)
             VALUES(?,?,?,?,?,?,?,0,?,?)",
        )
        .bind(owner.to_string())
        .bind(&identity.request_key)
        .bind(identity.conversation_id.to_string())
        .bind(&identity.name)
        .bind(&identity.v1_thread_id)
        .bind(&identity.remote_thread_id)
        .bind(&identity.workspace)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await;
        match inserted {
            Ok(_) => {}
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                return Err(ResourceError::Conflict("whatsapp_chat_conflict"))
            }
            Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => {
                return Err(ResourceError::NotFound)
            }
            Err(e) => return Err(unavailable(e)),
        }
        let value = Self::whatsapp_chat_row(&mut tx, owner, &identity.request_key)
            .await?
            .ok_or(ResourceError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Moves a provision forward to `stage` (never back) and records the group
    /// chat once; `error` records why the following stage failed instead.
    pub async fn advance_whatsapp_chat(
        &self,
        credential: &str,
        owner: &OwnerId,
        request_key: &str,
        stage: WhatsAppChatStage,
        chat_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<WhatsAppChatProvision> {
        if error.is_some_and(|e| {
            e.is_empty() || e.len() > 64 || !e.bytes().all(|b| b.is_ascii_graphic())
        }) || chat_id.is_some_and(|c| c.is_empty() || c.len() > 256)
        {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.whatsapp_chat_scope(credential, owner).await?;
        let current = Self::whatsapp_chat_row(&mut tx, owner, request_key)
            .await?
            .ok_or(ResourceError::NotFound)?;
        if current.chat_id.is_some() && chat_id.is_some() && current.chat_id.as_deref() != chat_id {
            return Err(ResourceError::Conflict("whatsapp_chat_group_changed"));
        }
        let next = stage.max(current.stage);
        if next >= WhatsAppChatStage::Group && current.chat_id.is_none() && chat_id.is_none() {
            return Err(ResourceError::Invalid);
        }
        sqlx::query(
            "UPDATE whatsapp_chat_provisions SET stage=?,chat_id=coalesce(chat_id,?),last_error=?,updated_at_ms=?
             WHERE owner_id=? AND request_key=?",
        )
        .bind(next.index())
        .bind(chat_id)
        .bind(error)
        .bind(now_ms())
        .bind(owner.to_string())
        .bind(request_key)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let value = Self::whatsapp_chat_row(&mut tx, owner, request_key)
            .await?
            .ok_or(ResourceError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Marks a provision archived (for example a disposable test chat). The
    /// row and its links are retained.
    pub async fn archive_whatsapp_chat(
        &self,
        credential: &str,
        owner: &OwnerId,
        request_key: &str,
    ) -> Result<WhatsAppChatProvision> {
        let mut tx = self.whatsapp_chat_scope(credential, owner).await?;
        Self::whatsapp_chat_row(&mut tx, owner, request_key)
            .await?
            .ok_or(ResourceError::NotFound)?;
        sqlx::query("UPDATE whatsapp_chat_provisions SET archived=1,updated_at_ms=? WHERE owner_id=? AND request_key=?")
            .bind(now_ms())
            .bind(owner.to_string())
            .bind(request_key)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let value = Self::whatsapp_chat_row(&mut tx, owner, request_key)
            .await?
            .ok_or(ResourceError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// The owner's provisions, newest first (bounded).
    pub async fn whatsapp_chats(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<Vec<WhatsAppChatProvision>> {
        let mut tx = self.whatsapp_chat_scope(credential, owner).await?;
        let rows = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM whatsapp_chat_provisions WHERE owner_id=? ORDER BY created_at_ms DESC,request_key LIMIT ?"
        ))
        .bind(owner.to_string())
        .bind(WHATSAPP_CHAT_LIST_MAX as i64)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let list = rows.iter().map(provision).collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(list)
    }
}

#[cfg(test)]
#[path = "whatsapp_chats_tests.rs"]
mod tests;
