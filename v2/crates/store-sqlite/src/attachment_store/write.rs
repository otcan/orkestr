use super::*;
use crate::attachment_integrity::{validate_attachment_bytes, validate_attachment_copy};
use sqlx::Row;
fn validate(request: &AttachmentImportRequest) -> Result<()> {
    if !key_valid(&request.request_key) {
        return Err(AttachmentError::Invalid);
    }
    let pairs: Vec<_> = request
        .mapping
        .iter()
        .map(|m| (m.source_reference_id, m.target_reference_id))
        .collect();
    validate_attachment_copy(&request.source.manifest, &request.target_manifest, &pairs)
        .map_err(|_| AttachmentError::Invalid)?;
    let mut seen = std::collections::HashSet::new();
    if request.source.contents.len() > ATTACHMENT_MAX_REFERENCES {
        return Err(AttachmentError::Invalid);
    }
    for c in &request.source.contents {
        if !seen.insert(c.reference_id) {
            return Err(AttachmentError::Invalid);
        }
        validate_attachment_bytes(
            &request.source.manifest,
            &request.source.manifest.owner_id,
            &request.source.manifest.conversation_id,
            c.reference_id,
            Some(&c.bytes),
        )
        .map_err(|_| AttachmentError::Invalid)?;
    }
    for r in &request.source.manifest.references {
        let content = request
            .source
            .contents
            .iter()
            .find(|c| c.reference_id == r.reference_id);
        validate_attachment_bytes(
            &request.source.manifest,
            &request.source.manifest.owner_id,
            &request.source.manifest.conversation_id,
            r.reference_id,
            content.map(|c| c.bytes.as_slice()),
        )
        .map_err(|_| AttachmentError::Invalid)?;
    }
    Ok(())
}
impl Store {
    pub async fn import_attachment_bundle_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportReceipt> {
        validate(request)?;
        if request.target_manifest.owner_id != *owner
            || request.target_manifest.conversation_id != *conversation
        {
            return Err(AttachmentError::NotFound);
        }
        let fingerprint = crate::digest(&serde_json::to_string(request).map_err(db)?);
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let old=sqlx::query("SELECT request_digest,receipt_json FROM attachment_imports WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(old) = old {
            if old.try_get::<String, _>("request_digest").map_err(db)? != fingerprint {
                return Err(AttachmentError::Conflict);
            }
            let receipt =
                serde_json::from_str(&old.try_get::<String, _>("receipt_json").map_err(db)?)
                    .map_err(db)?;
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        let collision: i64 =
            sqlx::query_scalar("SELECT count(*) FROM attachment_manifests WHERE id=?")
                .bind(request.target_manifest.manifest_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if collision != 0 {
            return Err(AttachmentError::Conflict);
        }
        for r in &request.target_manifest.references {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM attachment_objects WHERE reference_id=?")
                    .bind(r.reference_id.to_string())
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if count != 0 {
                return Err(AttachmentError::Conflict);
            }
        }
        // Recipient snapshot for this import, read inside the write transaction.
        let recipients = super::keys::active_recipients(&mut tx, owner).await?;
        let carries_bytes = request.mapping.iter().any(|m| {
            request
                .source
                .contents
                .iter()
                .any(|c| c.reference_id == m.source_reference_id)
        });
        if recipients.is_empty() && carries_bytes && super::keys::required(&mut tx, owner).await? {
            return Err(AttachmentError::EncryptionKeyRequired);
        }
        sqlx::query("INSERT INTO attachment_manifests(id,owner_id,conversation_id,manifest_json) VALUES(?,?,?,?)")
            .bind(request.target_manifest.manifest_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(serde_json::to_string(&request.target_manifest).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        for m in &request.mapping {
            let target = request
                .target_manifest
                .references
                .iter()
                .find(|r| r.reference_id == m.target_reference_id)
                .ok_or(AttachmentError::Invalid)?;
            let bytes = request
                .source
                .contents
                .iter()
                .find(|c| c.reference_id == m.source_reference_id)
                .map(|c| c.bytes.as_slice());
            // With an active recipient only ciphertext is stored (bytes stay NULL).
            let plaintext = if recipients.is_empty() { bytes } else { None };
            sqlx::query("INSERT INTO attachment_objects(reference_id,manifest_id,bytes,removed) VALUES(?,?,?,?)")
                .bind(m.target_reference_id.to_string()).bind(request.target_manifest.manifest_id.to_string()).bind(plaintext).bind(i64::from(target.state==AttachmentState::Removed))
                .execute(&mut *tx).await.map_err(db)?;
            if let (false, Some(bytes)) = (recipients.is_empty(), bytes) {
                super::keys::insert_sealed(
                    &mut tx,
                    &m.target_reference_id.to_string(),
                    &recipients,
                    &target.filename,
                    &target.media_type,
                    bytes,
                )
                .await?;
            }
        }
        let receipt = AttachmentImportReceipt {
            import_id: Uuid::new_v4(),
            manifest: request.target_manifest.clone(),
            source_manifest_id: request.source.manifest.manifest_id,
            mapping: request.mapping.clone(),
        };
        sqlx::query("INSERT INTO attachment_imports(id,owner_id,conversation_id,request_key,request_digest,manifest_id,source_manifest_json,receipt_json) VALUES(?,?,?,?,?,?,?,?)")
            .bind(receipt.import_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key).bind(fingerprint)
            .bind(receipt.manifest.manifest_id.to_string()).bind(serde_json::to_string(&request.source.manifest).map_err(db)?).bind(serde_json::to_string(&receipt).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("attachment-import-before-commit")
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("attachment-import-after-commit")
            .await
            .map_err(db)?;
        Ok(receipt)
    }
    pub async fn remove_attachment_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
        reference: Uuid,
        request_key: &str,
    ) -> Result<AttachmentRemovalReceipt> {
        if !key_valid(request_key) {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, true)
            .await?;
        let old:Option<String>=sqlx::query_scalar("SELECT receipt_json FROM attachment_removals WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(request_key).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(old) = old {
            let receipt: AttachmentRemovalReceipt = serde_json::from_str(&old).map_err(db)?;
            if receipt.manifest_id != manifest || receipt.reference_id != reference {
                return Err(AttachmentError::Conflict);
            }
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        let m = super::read::manifest_in(&mut tx, owner, conversation, manifest).await?;
        let r = m
            .references
            .iter()
            .find(|r| r.reference_id == reference)
            .ok_or(AttachmentError::NotFound)?;
        if r.state == AttachmentState::Inert {
            return Err(AttachmentError::Inert);
        }
        sqlx::query("DELETE FROM attachment_sealed_objects WHERE reference_id=? AND reference_id IN (SELECT reference_id FROM attachment_objects WHERE manifest_id=?)")
            .bind(reference.to_string()).bind(manifest.to_string()).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE attachment_objects SET bytes=NULL,removed=1 WHERE reference_id=? AND manifest_id=?")
            .bind(reference.to_string()).bind(manifest.to_string()).execute(&mut *tx).await.map_err(db)?;
        let receipt = AttachmentRemovalReceipt {
            manifest_id: manifest,
            reference_id: reference,
            removed: true,
        };
        sqlx::query("INSERT INTO attachment_removals(owner_id,conversation_id,request_key,manifest_id,reference_id,receipt_json) VALUES(?,?,?,?,?,?)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(request_key).bind(manifest.to_string()).bind(reference.to_string()).bind(serde_json::to_string(&receipt).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("attachment-remove-before-commit")
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("attachment-remove-after-commit")
            .await
            .map_err(db)?;
        Ok(receipt)
    }
}
