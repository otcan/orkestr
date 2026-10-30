//! Explicit recovery-only inactive-text export, one bounded read-only cut.
use super::recovery_export::*;
use super::*;
use sqlx::Connection;
use std::time::Duration;

impl Store {
    pub async fn export_history_recovery(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        native_conversation: &ConversationId,
    ) -> Result<HistoryRecoveryBundle> {
        if self.authority.is_some() {
            return Err(HistoryError::Unauthorized);
        }
        if namespace.is_nil()
            || native_conversation.0.is_nil()
            || namespace == native_conversation.0
        {
            return Err(HistoryError::Invalid);
        }
        let operation = async {
            let mut connection = self.pool.acquire().await.map_err(unavailable)?;
            connection.close_on_drop();
            sqlx::query("PRAGMA query_only=ON")
                .execute(&mut *connection)
                .await
                .map_err(unavailable)?;
            sqlx::query("PRAGMA trusted_schema=OFF")
                .execute(&mut *connection)
                .await
                .map_err(unavailable)?;
            let mut tx = connection.begin().await.map_err(unavailable)?;
            if !auth::authorized(&mut tx, credential, owner)
                .await
                .map_err(unavailable)?
            {
                return Err(HistoryError::Unauthorized);
            }
            // Refuse oversized raw fields before loading retained text into Rust.
            let ledger_size = sqlx::query("SELECT count(*) AS rows,coalesce(sum(length(CAST(text AS BLOB))+length(CAST(actor_kind AS BLOB))),0) AS bytes FROM (SELECT text,actor_kind FROM history_messages WHERE owner_id=? AND namespace=? LIMIT 100001)")
                .bind(owner.to_string()).bind(namespace.to_string()).fetch_one(&mut *tx).await.map_err(unavailable)?;
            if ledger_size.get::<i64, _>("rows") > MAX_RECOVERY_ROWS as i64
                || ledger_size.get::<i64, _>("bytes") > MAX_RECOVERY_SOURCE_BYTES as i64
            {
                return Err(HistoryError::Invalid);
            }
            let (original, current_receipt) = readback::verified(&mut tx, owner, namespace).await?;
            let native = sqlx::query(
                "SELECT project_id,sequence FROM conversations WHERE id=? AND owner_id=?",
            )
            .bind(native_conversation.to_string())
            .bind(owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(HistoryError::NotFound)?;
            let scope = match native.get::<Option<String>, _>("project_id") {
                Some(project) => fingerprint::parse_scope(&format!("project:{project}"))?,
                None => Scope::Global,
            };
            let watermark: i64 = native.get("sequence");
            if watermark < 0 {
                return Err(HistoryError::Conflict);
            }
            let size = sqlx::query("SELECT count(*) AS rows,coalesce(sum(length(CAST(text AS BLOB))+length(CAST(actor_kind AS BLOB))),0) AS bytes FROM (SELECT text,actor_kind FROM messages WHERE owner_id=? AND conversation_id=? AND sequence>0 AND sequence<=? ORDER BY sequence LIMIT 100001)")
                .bind(owner.to_string()).bind(native_conversation.to_string()).bind(watermark)
                .fetch_one(&mut *tx).await.map_err(unavailable)?;
            if size.get::<i64, _>("rows") > (MAX_RECOVERY_ROWS - original.messages.len()) as i64
                || size.get::<i64, _>("bytes") > MAX_RECOVERY_SOURCE_BYTES as i64
            {
                return Err(HistoryError::Invalid);
            }
            let rows = sqlx::query("SELECT id,sequence,actor_kind,text FROM messages WHERE owner_id=? AND conversation_id=? AND sequence>0 AND sequence<=? ORDER BY sequence LIMIT 100001")
                .bind(owner.to_string()).bind(native_conversation.to_string()).bind(watermark)
                .fetch_all(&mut *tx).await.map_err(unavailable)?;
            let mut messages = Vec::with_capacity(rows.len());
            for row in rows {
                let id: String = row.get("id");
                let parsed = Uuid::parse_str(&id).map_err(|_| HistoryError::Conflict)?;
                if parsed.to_string() != id {
                    return Err(HistoryError::Conflict);
                }
                messages.push(Message {
                    message_id: MessageId(parsed),
                    sequence: row.get("sequence"),
                    actor_kind: row.get("actor_kind"),
                    text: row.get("text"),
                    reply_to: None,
                    origin: None,
                });
            }
            let mut native_delta = HistoryImportRequest {
                namespace: native_conversation.0,
                source_conversation_id: native_conversation.clone(),
                source_scope: scope,
                source_watermark: watermark,
                source_digest: String::new(),
                messages,
            };
            native_delta.source_digest = history_source_digest(&native_delta)?;
            let mut bundle = HistoryRecoveryBundle {
                schema_version: 1,
                original,
                current_receipt,
                native_delta,
                bundle_digest: String::new(),
            };
            bundle.bundle_digest = history_recovery_digest(&bundle)?;
            tx.commit().await.map_err(unavailable)?;
            connection.close().await.map_err(unavailable)?;
            // Fresh auth outside the frozen cut, immediately before delivery.
            let mut current = self.history_transaction(credential, owner, false).await?;
            let owned: i64 =
                sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                    .bind(native_conversation.to_string())
                    .bind(owner.to_string())
                    .fetch_one(&mut *current)
                    .await
                    .map_err(unavailable)?;
            if owned != 1 {
                return Err(HistoryError::Unauthorized);
            }
            current.commit().await.map_err(unavailable)?;
            Ok(bundle)
        };
        tokio::time::timeout(Duration::from_secs(60), operation)
            .await
            .map_err(|_| HistoryError::Unavailable)?
    }
}
