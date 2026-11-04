//! Transactional bounded ciphertext storage. No base64, plaintext fallback,
//! full-file allocation, implicit message admission or provider export.
use super::*;
use sqlx::Row;

async fn status_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    id: Uuid,
) -> Result<EncryptedUploadStatus> {
    let row = sqlx::query("SELECT descriptor_json,recipients_json,ingest_recipient,complete,created_at FROM encrypted_uploads WHERE id=? AND owner_id=? AND conversation_id=?")
        .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_optional(&mut **tx).await.map_err(db)?.ok_or(AttachmentError::NotFound)?;
    let complete: i64 = row.try_get("complete").map_err(db)?;
    if complete == 0 {
        let live: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM encrypted_uploads WHERE id=? AND created_at>unixepoch()-86400",
        )
        .bind(id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if live != 1 {
            return Err(AttachmentError::NotFound);
        }
    }
    let file: EncryptedUploadStart =
        serde_json::from_str(&row.try_get::<String, _>("descriptor_json").map_err(db)?)
            .map_err(db)?;
    let recipients: Vec<String> =
        serde_json::from_str(&row.try_get::<String, _>("recipients_json").map_err(db)?)
            .map_err(db)?;
    if !file.is_valid() || file.upload_id != id || recipients.is_empty() {
        return Err(AttachmentError::Unavailable);
    }
    let rows = sqlx::query("SELECT chunk_index,length(ciphertext) AS size,ciphertext_sha256 FROM encrypted_upload_chunks WHERE upload_id=? ORDER BY chunk_index")
        .bind(id.to_string()).fetch_all(&mut **tx).await.map_err(db)?;
    let chunks = rows
        .into_iter()
        .map(|r| {
            Ok(EncryptedUploadChunk {
                index: r.try_get::<i64, _>("chunk_index").map_err(db)? as u64,
                ciphertext_size: r.try_get::<i64, _>("size").map_err(db)? as u64,
                ciphertext_sha256: r.try_get("ciphertext_sha256").map_err(db)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(EncryptedUploadStatus {
        format: ENCRYPTED_UPLOAD_FORMAT.into(),
        file,
        owner_id: owner.clone(),
        conversation_id: conversation.clone(),
        recipients,
        ingest_recipient: row.try_get("ingest_recipient").map_err(db)?,
        chunk_bytes: ENCRYPTED_UPLOAD_CHUNK_BYTES,
        chunks,
        complete: complete == 1,
    })
}

impl Store {
    /// A short publication lease: session revocation/deletion writers cannot
    /// commit between final authentication and the caller's atomic rename.
    /// The callback must perform only prepared-file publication, never crypto,
    /// network I/O or user work. No file bytes/private paths enter Core.
    pub async fn encrypted_upload_publish<F>(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        expected: &EncryptedUploadStatus,
        publish: F,
    ) -> Result<()>
    where
        F: FnOnce() -> Result<()>,
    {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let current = status_in(&mut tx, owner, conversation, expected.file.upload_id).await?;
        if !current.complete || current != *expected {
            return Err(AttachmentError::Conflict);
        }
        publish()?;
        tx.commit().await.map_err(db)
    }
    /// Idempotent creation. Sessions expire after 24h; at most eight open per
    /// owner. Reusing an id with different metadata or scope never resumes it.
    pub async fn encrypted_upload_start(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        file: &EncryptedUploadStart,
    ) -> Result<EncryptedUploadStatus> {
        self.encrypted_upload_start_for_ingest(credential, owner, conversation, file, None)
            .await
    }

    /// Trusted caller chooses the service public ingest recipient; a browser
    /// cannot substitute a key or remove the browser-recipient requirement.
    pub async fn encrypted_upload_start_for_ingest(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        file: &EncryptedUploadStart,
        ingest_recipient: Option<&str>,
    ) -> Result<EncryptedUploadStatus> {
        if !file.is_valid() {
            return Err(AttachmentError::Invalid);
        }
        if ingest_recipient.is_some_and(|r| seal::parse_recipient(r).is_none()) {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM encrypted_uploads WHERE id=?")
            .bind(file.upload_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if exists == 1 {
            let old = status_in(&mut tx, owner, conversation, file.upload_id).await?;
            if old.file != *file || old.ingest_recipient.as_deref() != ingest_recipient {
                return Err(AttachmentError::Conflict);
            }
            tx.commit().await.map_err(db)?;
            return Ok(old);
        }
        // Cascades release abandoned ciphertext, bounded to this owner.
        sqlx::query("DELETE FROM encrypted_uploads WHERE owner_id=? AND complete=0 AND created_at<=unixepoch()-86400")
            .bind(owner.to_string()).execute(&mut *tx).await.map_err(db)?;
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM encrypted_uploads WHERE owner_id=? AND complete=0",
        )
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if count >= 8 {
            return Err(AttachmentError::Conflict);
        }
        // Completed files remain charged; finishing cannot recycle disk quota.
        let reserved:i64=sqlx::query_scalar("SELECT coalesce(sum(((plaintext_size+1048575)/1048576)*1114112),0) FROM encrypted_uploads WHERE owner_id=?")
            .bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let incoming = file.chunk_count() * ENCRYPTED_UPLOAD_CIPHERTEXT_MAX as u64;
        if reserved as u64 + incoming > 4 * 1024 * 1024 * 1024 {
            return Err(AttachmentError::Conflict);
        }
        let recipients = super::keys::active_recipients(&mut tx, owner).await?;
        if recipients.is_empty() {
            return Err(AttachmentError::EncryptionKeyRequired);
        }
        let mut keys: Vec<_> = recipients.into_iter().map(|(_, key)| key).collect();
        if let Some(recipient) = ingest_recipient {
            if !keys.iter().any(|k| k == recipient) {
                keys.push(recipient.into());
            }
        }
        sqlx::query("INSERT INTO encrypted_uploads(id,owner_id,conversation_id,descriptor_json,recipients_json,ingest_recipient,plaintext_size,created_at) VALUES(?,?,?,?,?,?,?,unixepoch())")
            .bind(file.upload_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(serde_json::to_string(file).map_err(db)?).bind(serde_json::to_string(&keys).map_err(db)?).bind(ingest_recipient).bind(file.plaintext_size as i64)
            .execute(&mut *tx).await.map_err(db)?;
        let result = status_in(&mut tx, owner, conversation, file.upload_id).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    pub async fn encrypted_upload_status(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
    ) -> Result<EncryptedUploadStatus> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let result = status_in(&mut tx, owner, conversation, id).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// HTTP must apply the same bounded body limit BEFORE allocating bytes.
    /// The server records ciphertext integrity; only a recipient can validate
    /// age authentication and the encrypted per-chunk binding/size/checksum.
    // Keep authority, scope, immutable address and bytes explicit at this port.
    #[allow(clippy::too_many_arguments)]
    pub async fn encrypted_upload_put(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
        index: u64,
        digest: &str,
        ciphertext: &[u8],
    ) -> Result<EncryptedUploadChunk> {
        if ciphertext.len() > ENCRYPTED_UPLOAD_CIPHERTEXT_MAX
            || !ciphertext.starts_with(b"age-encryption.org/v1\n")
            || seal::sha256_hex(ciphertext) != digest
        {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let status = status_in(&mut tx, owner, conversation, id).await?;
        let plain = status
            .file
            .chunk_size(index)
            .ok_or(AttachmentError::Invalid)?;
        // age cannot compress; framing and tags only add bytes.
        if ciphertext.len() as u64 <= plain {
            return Err(AttachmentError::Invalid);
        }
        if let Some(old) = status.chunks.into_iter().find(|c| c.index == index) {
            if old.ciphertext_sha256 != digest || old.ciphertext_size != ciphertext.len() as u64 {
                return Err(AttachmentError::Conflict);
            }
            tx.commit().await.map_err(db)?;
            return Ok(old);
        }
        if status.complete {
            return Err(AttachmentError::Conflict);
        }
        sqlx::query("INSERT INTO encrypted_upload_chunks(upload_id,chunk_index,ciphertext,ciphertext_sha256) VALUES(?,?,?,?)")
            .bind(id.to_string()).bind(index as i64).bind(ciphertext).bind(digest).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(EncryptedUploadChunk {
            index,
            ciphertext_size: ciphertext.len() as u64,
            ciphertext_sha256: digest.into(),
        })
    }

    /// Commit a client-pinned ordered manifest. Missing chunks or mismatched
    /// receipts cannot become a completed object; retries are idempotent.
    pub async fn encrypted_upload_finish(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
        expected: &[EncryptedUploadChunk],
    ) -> Result<EncryptedUploadStatus> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let mut status = status_in(&mut tx, owner, conversation, id).await?;
        if expected != status.chunks
            || status.chunks.len() as u64 != status.file.chunk_count()
            || status
                .chunks
                .iter()
                .enumerate()
                .any(|(i, c)| c.index != i as u64)
        {
            return Err(AttachmentError::Conflict);
        }
        sqlx::query("UPDATE encrypted_uploads SET complete=1 WHERE id=?")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        status.complete = true;
        Ok(status)
    }

    /// Returns at most one ciphertext chunk, never concatenates the file.
    pub async fn encrypted_upload_chunk(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
        index: u64,
    ) -> Result<Vec<u8>> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let status = status_in(&mut tx, owner, conversation, id).await?;
        let receipt = status
            .chunks
            .iter()
            .find(|c| c.index == index)
            .ok_or(AttachmentError::NotFound)?;
        let bytes: Vec<u8> = sqlx::query_scalar(
            "SELECT ciphertext FROM encrypted_upload_chunks WHERE upload_id=? AND chunk_index=?",
        )
        .bind(id.to_string())
        .bind(index as i64)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if bytes.len() as u64 != receipt.ciphertext_size
            || seal::sha256_hex(&bytes) != receipt.ciphertext_sha256
        {
            return Err(AttachmentError::Unavailable);
        }
        tx.commit().await.map_err(db)?;
        Ok(bytes)
    }

    pub async fn encrypted_upload_remove(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
    ) -> Result<()> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        status_in(&mut tx, owner, conversation, id).await?;
        sqlx::query("DELETE FROM encrypted_uploads WHERE id=?")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
