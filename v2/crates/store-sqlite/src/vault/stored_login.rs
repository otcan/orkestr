//! The stored-login reader's read (`docs/v2/vault.md`, section 4). The server
//! authenticates the reader; this checks the desk lease and the helper's
//! selection policy, then returns ciphertext only. Every answer is audited.
use super::items::reader_print;
use super::*;
use crate::Store;
use orkestr_v2_contracts::{desktop_slug_valid, fencing_token_valid, ConversationId};
use serde::{Deserialize, Serialize};

const MAX_ITEM_IDS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredLoginMode {
    /// One password login for the site, chosen by the server.
    Auto,
    /// The helper's per-chat allow-list plus the lease thread's grants.
    Configured,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredLoginRequest {
    pub conversation_id: String,
    pub desk: String,
    pub fencing_token: String,
    pub site: String,
    pub mode: StoredLoginMode,
    #[serde(default)]
    pub item_ids: Vec<String>,
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub check: bool,
}
impl StoredLoginRequest {
    fn conversation(&self) -> Option<ConversationId> {
        uuid::Uuid::parse_str(&self.conversation_id)
            .ok()
            .filter(|id| !id.is_nil() && id.to_string() == self.conversation_id)
            .map(ConversationId)
    }
    fn valid(&self) -> bool {
        self.conversation().is_some()
            && desktop_slug_valid(&self.desk)
            && fencing_token_valid(&self.fencing_token)
            && site_valid(&self.site)
            && self.operation.len() <= 128
            && self
                .operation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            && match self.mode {
                StoredLoginMode::Auto => self.item_ids.is_empty() && self.site.contains('.'),
                StoredLoginMode::Configured => {
                    (1..=MAX_ITEM_IDS).contains(&self.item_ids.len())
                        && self.item_ids.iter().all(|id| item_id_valid(id))
                }
            }
    }
}

/// Metadata and, unless `check`, the ciphertext. The helper decrypts and
/// trusts only the sealed URL, domain and item id.
#[derive(Debug, Clone, Serialize)]
pub struct StoredLogin {
    pub item_id: String,
    pub url: String,
    pub domain: String,
    pub login_updated_at_ms: i64,
    pub sealed_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sealed_base64: Option<String>,
}

fn configured_match(site: &str, domain: &str) -> bool {
    domain.contains('.')
        && (site == domain
            || site.ends_with(&format!(".{domain}"))
            || domain.ends_with(&format!(".{site}")))
}

impl Store {
    /// `owner` and `reader` come from the server's trusted reader
    /// configuration, never from the request.
    pub async fn vault_stored_login(
        &self,
        owner: &OwnerId,
        reader: &str,
        request: &StoredLoginRequest,
    ) -> Result<StoredLogin> {
        if !request.valid() {
            return Err(VaultError::Invalid("vault_request_invalid"));
        }
        let conversation = request
            .conversation()
            .ok_or(VaultError::Invalid("vault_request_invalid"))?;
        let mut tx = self.vault_tx(true).await?;
        let outcome = select(&mut tx, owner, reader, &conversation, request).await;
        let conversation_text = conversation.to_string();
        let entry = || Audit {
            item: None,
            conversation: Some(&conversation_text),
            desk: Some(&request.desk),
            site: Some(&request.site),
            operation: Some(&request.operation),
            detail: None,
        };
        match outcome {
            Ok(found) => {
                let event = if request.check {
                    "stored_login_check"
                } else {
                    sqlx::query(
                        "UPDATE vault_items SET last_used_at_ms=? WHERE id=? AND owner_id=?",
                    )
                    .bind(now_ms())
                    .bind(&found.item_id)
                    .bind(owner.to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
                    "stored_login_read"
                };
                let mut row = entry();
                row.item = Some(&found.item_id);
                audit(&mut tx, owner, event, row).await?;
                tx.commit().await.map_err(db)?;
                Ok(found)
            }
            Err(error) => {
                let code = match error {
                    VaultError::Invalid(c) | VaultError::NotFound(c) | VaultError::Conflict(c) => c,
                    VaultError::Unauthorized => "unauthorized",
                    VaultError::Unavailable => return Err(error),
                };
                let mut row = entry();
                row.detail = Some(code);
                audit(&mut tx, owner, "stored_login_refused", row).await?;
                tx.commit().await.map_err(db)?;
                Err(error)
            }
        }
    }
}

async fn select(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    reader: &str,
    conversation: &ConversationId,
    request: &StoredLoginRequest,
) -> Result<StoredLogin> {
    // The lease is the proof that this chat holds this desk now. Its V1
    // thread comes from the lease record, never from the request.
    let thread: Option<String> = sqlx::query_scalar(
        "SELECT v1_thread_id FROM desktop_leases WHERE owner_id=? AND conversation_id=? AND desktop_slug=? AND state='active' AND token_hash=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(&request.desk)
    .bind(crate::conversation_resources::desktops::fence_hash(&request.fencing_token))
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let Some(thread) = thread else {
        return Err(VaultError::Conflict("desk_lease_required"));
    };
    let rows = sqlx::query(&format!(
        "SELECT {ROW_COLUMNS} FROM vault_items WHERE owner_id=? AND has_password=1 ORDER BY id"
    ))
    .bind(owner.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    let mut candidates = Vec::new();
    for row in &rows {
        let row = row_of(row)?;
        let eligible = match request.mode {
            StoredLoginMode::Auto => !row.single_use && site_within(&request.site, &row.domain),
            StoredLoginMode::Configured => request.item_ids.contains(&row.id)
                && configured_match(&request.site, &row.domain)
                && sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM vault_thread_grants WHERE item_id=? AND v1_thread_id=?",
                )
                .bind(&row.id)
                .bind(&thread)
                .fetch_one(&mut **tx)
                .await
                .map_err(db)?
                    == 1,
        };
        if eligible {
            candidates.push(row);
        }
    }
    let row = match candidates.len() {
        0 => return Err(VaultError::NotFound("no_credential_for_site")),
        1 => candidates.remove(0),
        _ => return Err(VaultError::Conflict("credential_ambiguous")),
    };
    if !reader_print(Some(reader)).is_some_and(|p| row.recipients.contains(&p)) {
        return Err(VaultError::Conflict("credential_not_sealed_for_reader"));
    }
    let (sealed, sha): (Vec<u8>, String) =
        sqlx::query_as("SELECT sealed,sealed_sha256 FROM vault_items WHERE id=? AND owner_id=?")
            .bind(&row.id)
            .bind(owner.to_string())
            .fetch_one(&mut **tx)
            .await
            .map_err(db)?;
    Ok(StoredLogin {
        sealed_base64: (!request.check).then(|| crate::attachment_store::keys::base64(&sealed)),
        sealed_sha256: sha,
        item_id: row.id,
        url: row.url,
        domain: row.domain,
        login_updated_at_ms: row.login_updated_at_ms,
    })
}
