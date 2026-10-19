use super::*;
use crate::attachment_integrity::validate_attachment_bytes;
use sqlx::Row;
pub(super) async fn manifest_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    id: Uuid,
) -> Result<AttachmentManifest> {
    let json:Option<String>=sqlx::query_scalar("SELECT manifest_json FROM attachment_manifests WHERE id=? AND owner_id=? AND conversation_id=?")
        .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut **tx).await.map_err(db)?;
    let mut manifest: AttachmentManifest =
        serde_json::from_str(&json.ok_or(AttachmentError::NotFound)?).map_err(db)?;
    if !manifest.is_valid()
        || manifest.owner_id != *owner
        || manifest.conversation_id != *conversation
        || manifest.manifest_id != id
    {
        return Err(AttachmentError::Unavailable);
    }
    for r in &mut manifest.references {
        let removed: i64 = sqlx::query_scalar(
            "SELECT removed FROM attachment_objects WHERE reference_id=? AND manifest_id=?",
        )
        .bind(r.reference_id.to_string())
        .bind(id.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        if removed == 1 && r.state != AttachmentState::Inert {
            r.state = AttachmentState::Removed;
        }
    }
    Ok(manifest)
}
impl Store {
    pub async fn attachment_manifest_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
    ) -> Result<AttachmentManifest> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let result = manifest_in(&mut tx, owner, conversation, manifest).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    pub async fn export_attachment_bundle_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
    ) -> Result<AttachmentBundle> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let manifest = manifest_in(&mut tx, owner, conversation, manifest).await?;
        let mut contents = Vec::new();
        for r in &manifest.references {
            if r.state == AttachmentState::Available {
                let bytes: Vec<u8> = sqlx::query_scalar(
                    "SELECT bytes FROM attachment_objects WHERE reference_id=? AND manifest_id=? AND length(bytes)=?",
                )
                .bind(r.reference_id.to_string())
                .bind(manifest.manifest_id.to_string())
                .bind(r.byte_length as i64)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                validate_attachment_bytes(
                    &manifest,
                    owner,
                    conversation,
                    r.reference_id,
                    Some(&bytes),
                )
                .map_err(|_| AttachmentError::Unavailable)?;
                contents.push(AttachmentContent {
                    reference_id: r.reference_id,
                    bytes,
                });
            }
        }
        tx.commit().await.map_err(db)?;
        // Revalidate current auth after releasing the fixed cut, before delivery.
        self.attachment_transaction(credential, owner, conversation, false)
            .await?
            .commit()
            .await
            .map_err(db)?;
        Ok(AttachmentBundle { manifest, contents })
    }
    pub async fn download_attachment_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
        reference: Uuid,
    ) -> Result<(AttachmentReference, Vec<u8>)> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let m = manifest_in(&mut tx, owner, conversation, manifest).await?;
        let r = m
            .references
            .iter()
            .find(|r| r.reference_id == reference)
            .ok_or(AttachmentError::NotFound)?
            .clone();
        match r.state {
            AttachmentState::Removed => return Err(AttachmentError::Removed),
            AttachmentState::Inert => return Err(AttachmentError::Inert),
            AttachmentState::Available => {}
        }
        let row = sqlx::query(
            "SELECT bytes FROM attachment_objects WHERE manifest_id=? AND reference_id=? AND length(bytes)=?",
        )
        .bind(manifest.to_string())
        .bind(reference.to_string())
        .bind(r.byte_length as i64)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let bytes: Vec<u8> = row.try_get("bytes").map_err(db)?;
        validate_attachment_bytes(&m, owner, conversation, reference, Some(&bytes))
            .map_err(|_| AttachmentError::Unavailable)?;
        tx.commit().await.map_err(db)?;
        self.attachment_transaction(credential, owner, conversation, false)
            .await?
            .commit()
            .await
            .map_err(db)?;
        Ok((r, bytes))
    }
}
