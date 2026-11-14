//! Owner calls: list, create, edit, replace a login, grants, delete, the
//! sealed form for the owner's browser, status and the audit list.
use super::*;
use crate::Store;
use serde::{Deserialize, Serialize};

/// Plain metadata of one item. Never a value or ciphertext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultItemView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub domain: String,
    pub tags: Vec<String>,
    pub has_password: bool,
    pub has_totp: bool,
    pub single_use: bool,
    pub thread_grants: Vec<String>,
    /// Fingerprints the login is sealed for.
    pub recipients: Vec<String>,
    /// Sealed for the configured stored-login reader.
    pub stored_login_ready: bool,
    pub source: Option<String>,
    pub revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub login_updated_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultStatus {
    pub items: i64,
    pub stored_login_configured: bool,
    pub stored_login_recipient: Option<String>,
    pub browser_recipients: Vec<String>,
    pub can_seal: bool,
}

/// `POST /api/v2/vault/items`. Not `Debug`: it holds values.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemCreate {
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemUpdate {
    pub expected_revision: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}
/// Replaces the whole sealed login. Not `Debug`: it holds values.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginReplace {
    pub expected_revision: i64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantsReplace {
    pub expected_revision: i64,
    pub v1_thread_ids: Vec<String>,
}

/// Ciphertext for the owner's browser to open with its own identity.
#[derive(Debug, Clone, Serialize)]
pub struct SealedLogin {
    pub item_id: String,
    pub sealed_base64: String,
    pub sealed_sha256: String,
    pub recipients: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditEvent {
    pub sequence: i64,
    pub at_ms: i64,
    pub event: String,
    pub item_id: Option<String>,
    pub conversation_id: Option<String>,
    pub desk: Option<String>,
    pub site: Option<String>,
    pub operation: Option<String>,
    pub detail: Option<String>,
}

pub(crate) fn reader_print(reader: Option<&str>) -> Option<String> {
    reader.map(seal::fingerprint)
}

async fn grants_of(tx: &mut Transaction<'_, Sqlite>, item: &str) -> Result<Vec<String>> {
    sqlx::query_scalar(
        "SELECT v1_thread_id FROM vault_thread_grants WHERE item_id=? ORDER BY v1_thread_id",
    )
    .bind(item)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)
}
async fn source_of(tx: &mut Transaction<'_, Sqlite>, item: &str) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT source FROM vault_import_sources WHERE item_id=? LIMIT 1")
        .bind(item)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)
}
pub(crate) async fn view(
    tx: &mut Transaction<'_, Sqlite>,
    row: StoredRow,
    reader: Option<&str>,
) -> Result<VaultItemView> {
    let print = reader_print(reader);
    Ok(VaultItemView {
        thread_grants: grants_of(tx, &row.id).await?,
        source: source_of(tx, &row.id).await?,
        stored_login_ready: print.is_some_and(|p| row.recipients.contains(&p)),
        id: row.id,
        name: row.name,
        url: row.url,
        domain: row.domain,
        tags: row.tags,
        has_password: row.has_password,
        has_totp: row.has_totp,
        single_use: row.single_use,
        recipients: row.recipients,
        revision: row.revision,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
        login_updated_at_ms: row.login_updated_at_ms,
        last_used_at_ms: row.last_used_at_ms,
    })
}
async fn view_by_id(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    id: &str,
    reader: Option<&str>,
) -> Result<VaultItemView> {
    let row = owned_row(tx, owner, id).await?;
    view(tx, row, reader).await
}
fn expect(row: &StoredRow, expected: i64) -> Result<()> {
    if row.revision != expected {
        return Err(VaultError::Conflict("vault_item_changed"));
    }
    Ok(())
}

/// Columns written for a new item (`INSERT`), in this order.
pub(crate) struct NewItem<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub tags: &'a [String],
    pub login: &'a Login,
    pub sealed: &'a Sealed,
    pub single_use: bool,
    pub created_at_ms: i64,
    pub login_updated_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
}
pub(crate) async fn insert_item(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    item: NewItem<'_>,
) -> Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_items WHERE owner_id=?")
        .bind(owner.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
    if count >= MAX_ITEMS {
        return Err(VaultError::Conflict("vault_full"));
    }
    let now = now_ms();
    sqlx::query("INSERT INTO vault_items(id,owner_id,name,url,domain,tags_json,has_password,has_totp,single_use,sealed,sealed_sha256,recipients_json,revision,created_at_ms,updated_at_ms,login_updated_at_ms,last_used_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)")
        .bind(item.id).bind(owner.to_string()).bind(item.name)
        .bind(&item.login.url).bind(&item.login.domain)
        .bind(serde_json::to_string(item.tags).map_err(db)?)
        .bind(!item.login.password.is_empty()).bind(item.login.totp.is_some()).bind(item.single_use)
        .bind(&item.sealed.ciphertext).bind(&item.sealed.sha256)
        .bind(serde_json::to_string(&item.sealed.fingerprints).map_err(db)?)
        .bind(item.created_at_ms).bind(now).bind(item.login_updated_at_ms).bind(item.last_used_at_ms)
        .execute(&mut **tx).await.map_err(db)?;
    Ok(())
}
/// Replaces the sealed login of an existing row and bumps its revision.
pub(crate) async fn write_login(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    id: &str,
    login: &Login,
    sealed: &Sealed,
    login_updated_at_ms: i64,
) -> Result<()> {
    sqlx::query("UPDATE vault_items SET url=?,domain=?,has_password=?,has_totp=?,sealed=?,sealed_sha256=?,recipients_json=?,revision=revision+1,updated_at_ms=?,login_updated_at_ms=? WHERE id=? AND owner_id=?")
        .bind(&login.url).bind(&login.domain).bind(!login.password.is_empty()).bind(login.totp.is_some())
        .bind(&sealed.ciphertext).bind(&sealed.sha256)
        .bind(serde_json::to_string(&sealed.fingerprints).map_err(db)?)
        .bind(now_ms()).bind(login_updated_at_ms).bind(id).bind(owner.to_string())
        .execute(&mut **tx).await.map_err(db)?;
    Ok(())
}
pub(crate) async fn write_grants(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
    grants: &[(String, i64)],
) -> Result<()> {
    sqlx::query("DELETE FROM vault_thread_grants WHERE item_id=?")
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    for (thread, at) in grants {
        sqlx::query(
            "INSERT INTO vault_thread_grants(item_id,v1_thread_id,granted_at_ms) VALUES(?,?,?)",
        )
        .bind(id)
        .bind(thread)
        .bind(at)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    }
    Ok(())
}

impl Store {
    pub(super) async fn vault_tx(&self, write: bool) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() {
            return Err(VaultError::Unauthorized);
        }
        self.pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(db)
    }

    /// The owner of a password-signed-in browser session (`kind='browser'`),
    /// the same check every vault call makes. For owner routes that manage
    /// credentials in another store (ORK-826).
    pub async fn vault_owner(&self, credential: &str) -> Result<OwnerId> {
        let mut tx = self.vault_tx(false).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        tx.commit().await.map_err(db)?;
        Ok(owner)
    }

    pub async fn vault_status(
        &self,
        credential: &str,
        reader: Option<&str>,
    ) -> Result<VaultStatus> {
        let mut tx = self.vault_tx(false).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let items: i64 = sqlx::query_scalar("SELECT count(*) FROM vault_items WHERE owner_id=?")
            .bind(owner.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let browsers = crate::attachment_store::keys::active_recipients(&mut tx, &owner)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(VaultStatus {
            items,
            stored_login_configured: reader.is_some(),
            stored_login_recipient: reader_print(reader),
            can_seal: reader.is_some() || !browsers.is_empty(),
            browser_recipients: browsers.into_iter().map(|(f, _)| f).collect(),
        })
    }

    pub async fn vault_items(
        &self,
        credential: &str,
        reader: Option<&str>,
    ) -> Result<Vec<VaultItemView>> {
        let mut tx = self.vault_tx(false).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let rows = sqlx::query(&format!(
            "SELECT {ROW_COLUMNS} FROM vault_items WHERE owner_id=? ORDER BY name COLLATE NOCASE,id"
        ))
        .bind(owner.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(view(&mut tx, row_of(row)?, reader).await?);
        }
        tx.commit().await.map_err(db)?;
        Ok(out)
    }

    pub async fn vault_create(
        &self,
        credential: &str,
        reader: Option<&str>,
        input: &ItemCreate,
    ) -> Result<VaultItemView> {
        let name = name(&input.name)?;
        let tags = tags(&input.tags)?;
        require_https_address(&input.url)?;
        let login = Login::new(&input.url, &input.username, &input.password, &input.notes)?;
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let recipients = recipients(&mut tx, &owner, reader).await?;
        let id = new_item_id();
        let sealed = seal_login(&recipients, &owner, &id, &login)?;
        let now = now_ms();
        insert_item(
            &mut tx,
            &owner,
            NewItem {
                id: &id,
                name: &name,
                tags: &tags,
                login: &login,
                sealed: &sealed,
                single_use: false,
                created_at_ms: now,
                login_updated_at_ms: now,
                last_used_at_ms: None,
            },
        )
        .await?;
        audit(
            &mut tx,
            &owner,
            "item_created",
            Audit {
                item: Some(&id),
                ..Default::default()
            },
        )
        .await?;
        let view = view_by_id(&mut tx, &owner, &id, reader).await?;
        tx.commit().await.map_err(db)?;
        Ok(view)
    }

    pub async fn vault_update(
        &self,
        credential: &str,
        reader: Option<&str>,
        id: &str,
        input: &ItemUpdate,
    ) -> Result<VaultItemView> {
        let name = input.name.as_deref().map(name).transpose()?;
        let tags = input.tags.as_deref().map(tags).transpose()?;
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let row = owned_row(&mut tx, &owner, id).await?;
        expect(&row, input.expected_revision)?;
        sqlx::query("UPDATE vault_items SET name=?,tags_json=?,revision=revision+1,updated_at_ms=? WHERE id=? AND owner_id=?")
            .bind(name.unwrap_or(row.name))
            .bind(serde_json::to_string(&tags.unwrap_or(row.tags)).map_err(db)?)
            .bind(now_ms()).bind(id).bind(owner.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        audit(
            &mut tx,
            &owner,
            "item_updated",
            Audit {
                item: Some(id),
                ..Default::default()
            },
        )
        .await?;
        let view = view_by_id(&mut tx, &owner, id, reader).await?;
        tx.commit().await.map_err(db)?;
        Ok(view)
    }

    pub async fn vault_replace_login(
        &self,
        credential: &str,
        reader: Option<&str>,
        id: &str,
        input: &LoginReplace,
    ) -> Result<VaultItemView> {
        require_https_address(&input.url)?;
        let login = Login::new(&input.url, &input.username, &input.password, &input.notes)?;
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let row = owned_row(&mut tx, &owner, id).await?;
        expect(&row, input.expected_revision)?;
        if row.single_use {
            return Err(VaultError::Conflict("vault_item_single_use"));
        }
        let recipients = recipients(&mut tx, &owner, reader).await?;
        let sealed = seal_login(&recipients, &owner, id, &login)?;
        write_login(&mut tx, &owner, id, &login, &sealed, now_ms()).await?;
        audit(
            &mut tx,
            &owner,
            "login_replaced",
            Audit {
                item: Some(id),
                ..Default::default()
            },
        )
        .await?;
        let view = view_by_id(&mut tx, &owner, id, reader).await?;
        tx.commit().await.map_err(db)?;
        Ok(view)
    }

    pub async fn vault_set_grants(
        &self,
        credential: &str,
        reader: Option<&str>,
        id: &str,
        input: &GrantsReplace,
    ) -> Result<VaultItemView> {
        let threads = thread_ids(&input.v1_thread_ids)?;
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let row = owned_row(&mut tx, &owner, id).await?;
        expect(&row, input.expected_revision)?;
        let now = now_ms();
        let kept: Vec<(String, i64)> = sqlx::query_as(
            "SELECT v1_thread_id,granted_at_ms FROM vault_thread_grants WHERE item_id=?",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        let grants: Vec<(String, i64)> = threads
            .into_iter()
            .map(|t| {
                let at = kept.iter().find(|(k, _)| *k == t).map_or(now, |(_, a)| *a);
                (t, at)
            })
            .collect();
        write_grants(&mut tx, id, &grants).await?;
        sqlx::query(
            "UPDATE vault_items SET revision=revision+1,updated_at_ms=? WHERE id=? AND owner_id=?",
        )
        .bind(now)
        .bind(id)
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        audit(
            &mut tx,
            &owner,
            "grants_changed",
            Audit {
                item: Some(id),
                ..Default::default()
            },
        )
        .await?;
        let view = view_by_id(&mut tx, &owner, id, reader).await?;
        tx.commit().await.map_err(db)?;
        Ok(view)
    }

    pub async fn vault_delete(&self, credential: &str, id: &str) -> Result<()> {
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        owned_row(&mut tx, &owner, id).await?;
        sqlx::query("DELETE FROM vault_items WHERE id=? AND owner_id=?")
            .bind(id)
            .bind(owner.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // The import mapping stays, so a later import does not bring it back.
        sqlx::query("UPDATE vault_import_sources SET item_id=NULL WHERE owner_id=? AND item_id=?")
            .bind(owner.to_string())
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        audit(
            &mut tx,
            &owner,
            "item_deleted",
            Audit {
                item: Some(id),
                ..Default::default()
            },
        )
        .await?;
        tx.commit().await.map_err(db)
    }

    pub async fn vault_sealed(&self, credential: &str, id: &str) -> Result<SealedLogin> {
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let row = owned_row(&mut tx, &owner, id).await?;
        let (sealed, sha): (Vec<u8>, String) = sqlx::query_as(
            "SELECT sealed,sealed_sha256 FROM vault_items WHERE id=? AND owner_id=?",
        )
        .bind(id)
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        audit(
            &mut tx,
            &owner,
            "owner_reveal",
            Audit {
                item: Some(id),
                ..Default::default()
            },
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(SealedLogin {
            item_id: row.id,
            sealed_base64: crate::attachment_store::keys::base64(&sealed),
            sealed_sha256: sha,
            recipients: row.recipients,
        })
    }

    pub async fn vault_audit(&self, credential: &str, limit: i64) -> Result<Vec<AuditEvent>> {
        let mut tx = self.vault_tx(false).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let rows = sqlx::query("SELECT sequence,at_ms,event,item_id,conversation_id,desk,site,operation,detail FROM vault_audit WHERE owner_id=? ORDER BY sequence DESC LIMIT ?")
            .bind(owner.to_string()).bind(limit.clamp(1, 500))
            .fetch_all(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        rows.iter()
            .map(|r| {
                Ok(AuditEvent {
                    sequence: r.try_get("sequence").map_err(db)?,
                    at_ms: r.try_get("at_ms").map_err(db)?,
                    event: r.try_get("event").map_err(db)?,
                    item_id: r.try_get("item_id").map_err(db)?,
                    conversation_id: r.try_get("conversation_id").map_err(db)?,
                    desk: r.try_get("desk").map_err(db)?,
                    site: r.try_get("site").map_err(db)?,
                    operation: r.try_get("operation").map_err(db)?,
                    detail: r.try_get("detail").map_err(db)?,
                })
            })
            .collect()
    }
}
