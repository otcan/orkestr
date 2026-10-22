use super::*;

pub(super) async fn verified(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<(HistoryImportRequest, HistoryImportReceipt)> {
    let row = sqlx::query("SELECT source_digest,source_conversation_id,source_scope,source_watermark,message_count,revision,active,rolled_back_at FROM history_imports WHERE owner_id=? AND namespace=?")
        .bind(owner.to_string()).bind(namespace.to_string()).fetch_optional(&mut **tx).await.map_err(unavailable)?
        .ok_or(HistoryError::NotFound)?;
    let revision: i64 = row.get("revision");
    let active: i64 = row.get("active");
    let rolled: Option<i64> = row.get("rolled_back_at");
    if !((revision == 1 && active == 1 && rolled.is_none())
        || (revision == 2 && active == 0 && rolled.is_some()))
    {
        return Err(HistoryError::Conflict);
    }
    let count: i64 = row.get("message_count");
    if !(0..=100_000).contains(&count) {
        return Err(HistoryError::Conflict);
    }
    let rows = sqlx::query("SELECT ordinal,source_message_id,source_sequence,actor_kind,text FROM history_messages WHERE owner_id=? AND namespace=? ORDER BY ordinal LIMIT 100001")
        .bind(owner.to_string()).bind(namespace.to_string()).fetch_all(&mut **tx).await.map_err(unavailable)?;
    if rows.len() != count as usize {
        return Err(HistoryError::Conflict);
    }
    let mut messages = Vec::with_capacity(rows.len());
    for (ordinal, row) in rows.iter().enumerate() {
        if row.get::<i64, _>("ordinal") != ordinal as i64 {
            return Err(HistoryError::Conflict);
        }
        let id: String = row.get("source_message_id");
        let uuid = Uuid::parse_str(&id).map_err(|_| HistoryError::Conflict)?;
        if uuid.to_string() != id {
            return Err(HistoryError::Conflict);
        }
        messages.push(Message {
            message_id: MessageId(uuid),
            sequence: row.get("source_sequence"),
            actor_kind: row.get("actor_kind"),
            text: row.get("text"),
            reply_to: None,
            origin: None,
        });
    }
    let conversation: String = row.get("source_conversation_id");
    let id = Uuid::parse_str(&conversation).map_err(|_| HistoryError::Conflict)?;
    if id.to_string() != conversation {
        return Err(HistoryError::Conflict);
    }
    let request = HistoryImportRequest {
        namespace,
        source_digest: row.get("source_digest"),
        source_conversation_id: ConversationId(id),
        source_scope: fingerprint::parse_scope(&row.get::<String, _>("source_scope"))?,
        source_watermark: row.get("source_watermark"),
        messages,
    };
    if history_source_digest(&request).map_err(|_| HistoryError::Conflict)? != request.source_digest
    {
        return Err(HistoryError::Conflict);
    }
    let receipt = HistoryImportReceipt {
        schema_version: 1,
        owner_id: owner.clone(),
        namespace,
        source_digest: request.source_digest.clone(),
        source_conversation_id: request.source_conversation_id.clone(),
        source_watermark: request.source_watermark,
        message_count: count as u64,
        revision,
        active: active == 1,
    };
    Ok((request, receipt))
}
impl Store {
    pub async fn history_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
    ) -> Result<HistoryImportReceipt> {
        if namespace.is_nil() {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let receipt = verified(&mut tx, owner, namespace).await?.1;
        tx.commit().await.map_err(unavailable)?;
        Ok(receipt)
    }
    pub async fn history_messages(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Message>> {
        if namespace.is_nil() || !(1..=100).contains(&limit) || after.is_some_and(|n| n < 0) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, false).await?;
        let (request, receipt) = verified(&mut tx, owner, namespace).await?;
        let messages = if receipt.active {
            request
                .messages
                .into_iter()
                .filter(|m| m.sequence > after.unwrap_or(0))
                .take(limit as usize)
                .collect()
        } else {
            Vec::new()
        };
        tx.commit().await.map_err(unavailable)?;
        Ok(messages)
    }
}
