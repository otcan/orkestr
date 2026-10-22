//! Owner registry of browser age recipients (V1 protocol) and the sealing of
//! plaintext residue once a recipient is active.
use super::seal::{self, fingerprint, parse_recipient, PROOF_PREFIX};
use super::*;
use sqlx::Row;

/// Operator switch: refuse new objects while no recipient is active.
pub const REQUIRED_ENV: &str = "ORKESTR_V2_ATTACHMENT_ENCRYPTION_REQUIRED";
const CHALLENGE_TTL_SECONDS: i64 = 15 * 60;
const CHALLENGE_ATTEMPTS_MAX: i64 = 5;
const RECIPIENTS_MAX: i64 = 64;

pub(super) fn required_by_environment() -> bool {
    matches!(
        std::env::var(REQUIRED_ENV)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// A recipient the operator imports from the V1 registry (public data only).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedRecipient {
    pub recipient: String,
    #[serde(default)]
    pub label: String,
    /// Unix seconds of the V1 possession proof.
    pub verified_at: i64,
}

pub(super) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn clean_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn record(row: &sqlx::sqlite::SqliteRow) -> Result<AttachmentRecipientRecord> {
    let status = match row.try_get::<String, _>("status").map_err(db)?.as_str() {
        "pending_verification" => AttachmentRecipientStatus::PendingVerification,
        "active" => AttachmentRecipientStatus::Active,
        "revoked" => AttachmentRecipientStatus::Revoked,
        _ => return Err(AttachmentError::Unavailable),
    };
    let origin = match row.try_get::<String, _>("origin").map_err(db)?.as_str() {
        "enrolled" => AttachmentRecipientOrigin::Enrolled,
        "v1_import" => AttachmentRecipientOrigin::V1Import,
        _ => return Err(AttachmentError::Unavailable),
    };
    let challenge = match (
        status,
        row.try_get::<Option<String>, _>("challenge_id")
            .map_err(db)?,
    ) {
        (AttachmentRecipientStatus::PendingVerification, Some(id)) => {
            Some(AttachmentRecipientChallenge {
                id: Uuid::parse_str(&id).map_err(db)?,
                ciphertext_base64: base64(
                    &row.try_get::<Vec<u8>, _>("challenge_ciphertext")
                        .map_err(db)?,
                ),
                expires_at: row.try_get("challenge_expires_at").map_err(db)?,
            })
        }
        _ => None,
    };
    Ok(AttachmentRecipientRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id").map_err(db)?).map_err(db)?,
        label: row.try_get("label").map_err(db)?,
        recipient: row.try_get("recipient").map_err(db)?,
        fingerprint: row.try_get("fingerprint").map_err(db)?,
        status,
        origin,
        created_at: row.try_get("created_at").map_err(db)?,
        verified_at: row.try_get("verified_at").map_err(db)?,
        revoked_at: row.try_get("revoked_at").map_err(db)?,
        revoked_reason: row.try_get("revoked_reason").map_err(db)?,
        challenge,
    })
}

async fn record_by_id(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    id: Uuid,
) -> Result<AttachmentRecipientRecord> {
    let row = sqlx::query("SELECT * FROM attachment_recipients WHERE id=? AND owner_id=?")
        .bind(id.to_string())
        .bind(owner.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or(AttachmentError::NotFound)?;
    record(&row)
}

/// `(fingerprint, recipient)` of the owner's active recipients, in a stable order.
pub(super) async fn active_recipients(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
) -> Result<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT fingerprint,recipient FROM attachment_recipients WHERE owner_id=? AND status='active' ORDER BY created_at,id",
    )
    .bind(owner.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get("fingerprint").map_err(db)?,
                r.try_get("recipient").map_err(db)?,
            ))
        })
        .collect()
}

pub(super) async fn required(tx: &mut Transaction<'_, Sqlite>, owner: &OwnerId) -> Result<bool> {
    let stored: Option<i64> =
        sqlx::query_scalar("SELECT required FROM attachment_encryption_policies WHERE owner_id=?")
            .bind(owner.to_string())
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?;
    Ok(required_by_environment() || stored == Some(1))
}

async fn set_required(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    value: bool,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO attachment_encryption_policies(owner_id,required,revision,updated_at) VALUES(?,?,1,unixepoch())
         ON CONFLICT(owner_id) DO UPDATE SET required=excluded.required,revision=revision+1,updated_at=unixepoch()",
    )
    .bind(owner.to_string())
    .bind(i64::from(value))
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

/// Seals every plaintext object of `owner` for the active recipients. Returns
/// how many were sealed; does nothing while no recipient is active.
pub(super) async fn seal_plaintext_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
) -> Result<u64> {
    let recipients = active_recipients(tx, owner).await?;
    if recipients.is_empty() {
        return Ok(0);
    }
    let rows = sqlx::query(
        "SELECT o.reference_id,o.bytes,m.manifest_json FROM attachment_objects o
         JOIN attachment_manifests m ON m.id=o.manifest_id
         WHERE m.owner_id=? AND o.removed=0 AND o.bytes IS NOT NULL",
    )
    .bind(owner.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    let mut sealed = 0;
    for row in rows {
        let reference: String = row.try_get("reference_id").map_err(db)?;
        let bytes: Vec<u8> = row.try_get("bytes").map_err(db)?;
        let manifest: AttachmentManifest =
            serde_json::from_str(&row.try_get::<String, _>("manifest_json").map_err(db)?)
                .map_err(db)?;
        let id = Uuid::parse_str(&reference).map_err(db)?;
        let r = manifest
            .references
            .iter()
            .find(|r| r.reference_id == id)
            .ok_or(AttachmentError::Unavailable)?;
        // Never seal bytes that do not match their manifest entry.
        crate::attachment_integrity::validate_attachment_bytes(
            &manifest,
            &manifest.owner_id,
            &manifest.conversation_id,
            id,
            Some(&bytes),
        )
        .map_err(|_| AttachmentError::Unavailable)?;
        insert_sealed(
            tx,
            &reference,
            &recipients,
            &r.filename,
            &r.media_type,
            &bytes,
        )
        .await?;
        sealed += 1;
    }
    Ok(sealed)
}

/// Writes the ciphertext row and clears the plaintext column.
pub(super) async fn insert_sealed(
    tx: &mut Transaction<'_, Sqlite>,
    reference: &str,
    recipients: &[(String, String)],
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<()> {
    let sealed = seal::seal(recipients, filename, media_type, bytes)
        .map_err(|_| AttachmentError::Unavailable)?;
    sqlx::query("UPDATE attachment_objects SET bytes=NULL WHERE reference_id=? AND removed=0")
        .bind(reference)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    sqlx::query(
        "INSERT INTO attachment_sealed_objects(reference_id,format,ciphertext,ciphertext_sha256,recipient_fingerprints_json,sealed_at) VALUES(?,?,?,?,?,unixepoch())",
    )
    .bind(reference)
    .bind(seal::SEALED_FORMAT)
    .bind(&sealed.ciphertext)
    .bind(&sealed.ciphertext_sha256)
    .bind(serde_json::to_string(&sealed.fingerprints).map_err(db)?)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}

impl Store {
    async fn key_transaction(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(AttachmentError::Unauthorized);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let auth: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if auth != 1 {
            return Err(AttachmentError::Unauthorized);
        }
        Ok(tx)
    }

    async fn status_in(
        tx: &mut Transaction<'_, Sqlite>,
        owner: &OwnerId,
    ) -> Result<AttachmentEncryptionStatus> {
        let rows = sqlx::query(
            "SELECT * FROM attachment_recipients WHERE owner_id=? ORDER BY created_at,id",
        )
        .bind(owner.to_string())
        .fetch_all(&mut **tx)
        .await
        .map_err(db)?;
        let keys = rows.iter().map(record).collect::<Result<Vec<_>>>()?;
        let count = |sql: &'static str| sqlx::query_scalar::<_, i64>(sql).bind(owner.to_string());
        let plaintext_objects = count(
            "SELECT count(*) FROM attachment_objects o JOIN attachment_manifests m ON m.id=o.manifest_id WHERE m.owner_id=? AND o.bytes IS NOT NULL",
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        let sealed_objects = count(
            "SELECT count(*) FROM attachment_sealed_objects s JOIN attachment_objects o ON o.reference_id=s.reference_id JOIN attachment_manifests m ON m.id=o.manifest_id WHERE m.owner_id=?",
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
        Ok(AttachmentEncryptionStatus {
            owner_id: owner.clone(),
            required: required(tx, owner).await?,
            ready: keys
                .iter()
                .any(|k| k.status == AttachmentRecipientStatus::Active),
            keys,
            plaintext_objects: plaintext_objects as u64,
            sealed_objects: sealed_objects as u64,
        })
    }

    pub async fn attachment_encryption_status(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<AttachmentEncryptionStatus> {
        let mut tx = self.key_transaction(credential, owner).await?;
        let status = Self::status_in(&mut tx, owner).await?;
        tx.commit().await.map_err(db)?;
        Ok(status)
    }

    /// Registers a recipient and issues its possession challenge. An already
    /// active recipient is returned unchanged.
    pub async fn register_attachment_recipient(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &AttachmentRecipientRegistration,
    ) -> Result<AttachmentRecipientRecord> {
        let recipient = request.recipient.trim();
        if parse_recipient(recipient).is_none() || request.label.len() > 1024 {
            return Err(AttachmentError::Invalid);
        }
        let fingerprint = fingerprint(recipient);
        // Two v4 UUIDs: 244 random bits from the OS generator.
        let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let proof = format!("{PROOF_PREFIX}{nonce}");
        let ciphertext = seal::encrypt(&[recipient.to_owned()], proof.as_bytes())
            .map_err(|_| AttachmentError::Invalid)?;
        let mut tx = self.key_transaction(credential, owner).await?;
        let existing = sqlx::query(
            "SELECT id,status FROM attachment_recipients WHERE owner_id=? AND fingerprint=?",
        )
        .bind(owner.to_string())
        .bind(&fingerprint)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        let id = match &existing {
            Some(row) => {
                let id =
                    Uuid::parse_str(&row.try_get::<String, _>("id").map_err(db)?).map_err(db)?;
                if row.try_get::<String, _>("status").map_err(db)? == "active" {
                    let found = record_by_id(&mut tx, owner, id).await?;
                    tx.commit().await.map_err(db)?;
                    return Ok(found);
                }
                id
            }
            None => {
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM attachment_recipients WHERE owner_id=?",
                )
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                if count >= RECIPIENTS_MAX {
                    return Err(AttachmentError::Conflict);
                }
                Uuid::new_v4()
            }
        };
        sqlx::query(
            "INSERT INTO attachment_recipients(id,owner_id,label,recipient,fingerprint,status,origin,created_at,challenge_id,challenge_nonce_hash,challenge_ciphertext,challenge_expires_at,challenge_attempts)
             VALUES(?,?,?,?,?,'pending_verification','enrolled',unixepoch(),?,?,?,unixepoch()+?,0)
             ON CONFLICT(id) DO UPDATE SET label=excluded.label,status='pending_verification',origin='enrolled',
              verified_at=NULL,revoked_at=NULL,revoked_reason=NULL,challenge_id=excluded.challenge_id,
              challenge_nonce_hash=excluded.challenge_nonce_hash,challenge_ciphertext=excluded.challenge_ciphertext,
              challenge_expires_at=excluded.challenge_expires_at,challenge_attempts=0",
        )
        .bind(id.to_string())
        .bind(owner.to_string())
        .bind(clean_label(&request.label))
        .bind(recipient)
        .bind(&fingerprint)
        .bind(Uuid::new_v4().to_string())
        .bind(seal::sha256_hex(proof.as_bytes()))
        .bind(&ciphertext)
        .bind(CHALLENGE_TTL_SECONDS)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let created = record_by_id(&mut tx, owner, id).await?;
        tx.commit().await.map_err(db)?;
        Ok(created)
    }

    /// Activates a pending recipient whose browser returned the decrypted
    /// challenge, then seals any plaintext residue for the new recipient set.
    pub async fn verify_attachment_recipient(
        &self,
        credential: &str,
        owner: &OwnerId,
        id: Uuid,
        proof: &str,
    ) -> Result<AttachmentRecipientRecord> {
        if proof.len() > 1024 {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self.key_transaction(credential, owner).await?;
        let row = sqlx::query(
            "SELECT status,challenge_nonce_hash,challenge_expires_at>unixepoch() AS live,challenge_attempts FROM attachment_recipients WHERE id=? AND owner_id=?",
        )
        .bind(id.to_string())
        .bind(owner.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(AttachmentError::NotFound)?;
        if row.try_get::<String, _>("status").map_err(db)? != "pending_verification"
            || !row.try_get::<bool, _>("live").map_err(db)?
            || row.try_get::<i64, _>("challenge_attempts").map_err(db)? >= CHALLENGE_ATTEMPTS_MAX
        {
            return Err(AttachmentError::Conflict);
        }
        let expected: String = row.try_get("challenge_nonce_hash").map_err(db)?;
        let actual = seal::sha256_hex(proof.trim().as_bytes());
        // Both are fixed-length hex digests of secret inputs; compare without early exit.
        let equal = expected.len() == actual.len()
            && expected
                .bytes()
                .zip(actual.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0;
        if !equal {
            sqlx::query("UPDATE attachment_recipients SET challenge_attempts=challenge_attempts+1 WHERE id=?")
                .bind(id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            return Err(AttachmentError::Invalid);
        }
        sqlx::query(
            "UPDATE attachment_recipients SET status='active',verified_at=unixepoch(),challenge_id=NULL,challenge_nonce_hash=NULL,challenge_ciphertext=NULL,challenge_expires_at=NULL WHERE id=?",
        )
        .bind(id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        seal_plaintext_in(&mut tx, owner).await?;
        let verified = record_by_id(&mut tx, owner, id).await?;
        tx.commit().await.map_err(db)?;
        Ok(verified)
    }

    /// Future objects exclude a revoked recipient; existing ciphertext keeps
    /// its original recipient snapshot.
    pub async fn revoke_attachment_recipient(
        &self,
        credential: &str,
        owner: &OwnerId,
        id: Uuid,
        reason: &str,
    ) -> Result<AttachmentRecipientRecord> {
        let mut tx = self.key_transaction(credential, owner).await?;
        record_by_id(&mut tx, owner, id).await?;
        let reason: String = reason
            .chars()
            .filter(|c| !c.is_control())
            .take(300)
            .collect();
        sqlx::query(
            "UPDATE attachment_recipients SET status='revoked',revoked_at=coalesce(revoked_at,unixepoch()),revoked_reason=?,challenge_id=NULL,challenge_nonce_hash=NULL,challenge_ciphertext=NULL,challenge_expires_at=NULL WHERE id=?",
        )
        .bind(if reason.trim().is_empty() { "recipient_revoked".to_owned() } else { reason.trim().to_owned() })
        .bind(id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let revoked = record_by_id(&mut tx, owner, id).await?;
        tx.commit().await.map_err(db)?;
        Ok(revoked)
    }

    /// Turning the fail-closed policy on needs an active recipient (V1 rule).
    pub async fn set_attachment_encryption_policy(
        &self,
        credential: &str,
        owner: &OwnerId,
        required_value: bool,
    ) -> Result<AttachmentEncryptionStatus> {
        let mut tx = self.key_transaction(credential, owner).await?;
        if required_value && active_recipients(&mut tx, owner).await?.is_empty() {
            return Err(AttachmentError::EncryptionKeyRequired);
        }
        set_required(&mut tx, owner, required_value).await?;
        let status = Self::status_in(&mut tx, owner).await?;
        tx.commit().await.map_err(db)?;
        Ok(status)
    }

    /// Operator import of V1-verified recipients for the owner. Idempotent:
    /// known fingerprints are left as they are (a revoked key stays revoked).
    /// Enables the fail-closed policy when any recipient ends up active and
    /// seals plaintext residue. Returns how many recipients were added.
    pub async fn import_attachment_recipients(
        &self,
        owner: &OwnerId,
        recipients: &[ImportedRecipient],
    ) -> Result<u64> {
        if self.authority.is_some() || recipients.len() > RECIPIENTS_MAX as usize {
            return Err(AttachmentError::Unauthorized);
        }
        if recipients
            .iter()
            .any(|r| parse_recipient(&r.recipient).is_none() || r.verified_at <= 0)
        {
            return Err(AttachmentError::Invalid);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let known: i64 = sqlx::query_scalar("SELECT count(*) FROM owners WHERE id=?")
            .bind(owner.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if known != 1 {
            return Err(AttachmentError::NotFound);
        }
        let mut added = 0;
        for r in recipients {
            added += sqlx::query(
                "INSERT INTO attachment_recipients(id,owner_id,label,recipient,fingerprint,status,origin,created_at,verified_at)
                 VALUES(?,?,?,?,?,'active','v1_import',unixepoch(),?) ON CONFLICT(owner_id,fingerprint) DO NOTHING",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(owner.to_string())
            .bind(clean_label(&r.label))
            .bind(&r.recipient)
            .bind(fingerprint(&r.recipient))
            .bind(r.verified_at)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        }
        if !active_recipients(&mut tx, owner).await?.is_empty() {
            set_required(&mut tx, owner, true).await?;
            seal_plaintext_in(&mut tx, owner).await?;
        }
        tx.commit().await.map_err(db)?;
        Ok(added)
    }

    /// Startup sweep: seals plaintext objects of every owner who has an
    /// active recipient. Returns how many objects were sealed.
    pub async fn seal_plaintext_attachments(&self) -> Result<u64> {
        if self.authority.is_some() {
            return Err(AttachmentError::Unauthorized);
        }
        let owners: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT owner_id FROM attachment_recipients WHERE status='active'",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        let mut sealed = 0;
        for owner in owners {
            let owner = OwnerId(Uuid::parse_str(&owner).map_err(db)?);
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            sealed += seal_plaintext_in(&mut tx, &owner).await?;
            tx.commit().await.map_err(db)?;
        }
        Ok(sealed)
    }
}
