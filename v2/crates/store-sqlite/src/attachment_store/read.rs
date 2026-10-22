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
/// One stored object: legacy plaintext or age ciphertext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredObject {
    Plain(Vec<u8>),
    Sealed {
        ciphertext: Vec<u8>,
        recipient_fingerprints: Vec<String>,
    },
}
/// Bytes of an available reference, integrity-checked: plaintext against the
/// manifest digest, ciphertext against its recorded digest.
async fn stored_object(
    tx: &mut Transaction<'_, Sqlite>,
    manifest: &AttachmentManifest,
    owner: &OwnerId,
    conversation: &ConversationId,
    reference: &AttachmentReference,
) -> Result<StoredObject> {
    let row = sqlx::query(
        "SELECT o.bytes,s.format,s.ciphertext,s.ciphertext_sha256,s.recipient_fingerprints_json FROM attachment_objects o
         LEFT JOIN attachment_sealed_objects s ON s.reference_id=o.reference_id
         WHERE o.manifest_id=? AND o.reference_id=? AND o.removed=0",
    )
    .bind(manifest.manifest_id.to_string())
    .bind(reference.reference_id.to_string())
    .fetch_one(&mut **tx)
    .await
    .map_err(db)?;
    if let Some(bytes) = row.try_get::<Option<Vec<u8>>, _>("bytes").map_err(db)? {
        validate_attachment_bytes(
            manifest,
            owner,
            conversation,
            reference.reference_id,
            Some(&bytes),
        )
        .map_err(|_| AttachmentError::Unavailable)?;
        return Ok(StoredObject::Plain(bytes));
    }
    let format: Option<String> = row.try_get("format").map_err(db)?;
    let ciphertext: Vec<u8> = row
        .try_get::<Option<Vec<u8>>, _>("ciphertext")
        .map_err(db)?
        .ok_or(AttachmentError::Unavailable)?;
    let digest: String = row.try_get("ciphertext_sha256").map_err(db)?;
    let fingerprints: Vec<String> = serde_json::from_str(
        &row.try_get::<String, _>("recipient_fingerprints_json")
            .map_err(db)?,
    )
    .map_err(db)?;
    if format.as_deref() != Some(super::seal::SEALED_FORMAT)
        || super::seal::sha256_hex(&ciphertext) != digest
        || !ciphertext.starts_with(b"age-encryption.org/v1\n")
        || fingerprints.is_empty()
    {
        return Err(AttachmentError::Unavailable);
    }
    Ok(StoredObject::Sealed {
        ciphertext,
        recipient_fingerprints: fingerprints,
    })
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
    /// The manifest's available objects as stored. Sealed objects stay age
    /// ciphertext; only a browser holding a recipient identity can open them.
    pub async fn export_attachment_bundle_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
    ) -> Result<StoredAttachmentBundle> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let manifest = manifest_in(&mut tx, owner, conversation, manifest).await?;
        let mut contents = Vec::new();
        for r in &manifest.references {
            if r.state == AttachmentState::Available {
                let content =
                    match stored_object(&mut tx, &manifest, owner, conversation, r).await? {
                        StoredObject::Plain(bytes) => StoredAttachmentContent {
                            reference_id: r.reference_id,
                            format: StoredAttachmentFormat::Plain,
                            bytes,
                            recipient_fingerprints: Vec::new(),
                        },
                        StoredObject::Sealed {
                            ciphertext,
                            recipient_fingerprints,
                        } => StoredAttachmentContent {
                            reference_id: r.reference_id,
                            format: StoredAttachmentFormat::AgeX25519V1,
                            bytes: ciphertext,
                            recipient_fingerprints,
                        },
                    };
                contents.push(content);
            }
        }
        tx.commit().await.map_err(db)?;
        // Revalidate current auth after releasing the fixed cut, before delivery.
        self.attachment_transaction(credential, owner, conversation, false)
            .await?
            .commit()
            .await
            .map_err(db)?;
        Ok(StoredAttachmentBundle { manifest, contents })
    }
    pub async fn download_attachment_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
        reference: Uuid,
    ) -> Result<(AttachmentReference, StoredObject)> {
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
        let stored = stored_object(&mut tx, &m, owner, conversation, &r).await?;
        tx.commit().await.map_err(db)?;
        self.attachment_transaction(credential, owner, conversation, false)
            .await?
            .commit()
            .await
            .map_err(db)?;
        Ok((r, stored))
    }
}
