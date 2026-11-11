//! Idempotent import of V1 vault items (`docs/v2/vault.md`, section 6).
//!
//! `source_checksum` is computed by the importer over the V1 record as
//! stored (metadata and V1 envelope, which is ciphertext), never over a value.
//! Per source id: new -> `imported`; same checksum -> `unchanged`; changed in
//! V1 only -> `updated`; changed in V1 and edited in V2 -> `conflict`;
//! deleted by the owner in V2 -> `deleted_in_v2`. Nothing is ever restored or
//! overwritten behind the owner's back.
use super::items::{insert_item, write_grants, write_login, NewItem};
use super::*;
use crate::Store;
use serde::{Deserialize, Serialize};

pub const MAX_IMPORT_ITEMS: usize = 500;

/// Not `Debug`: entries hold values.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub format: String,
    pub source: String,
    pub items: Vec<ImportEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportEntry {
    pub source_id: String,
    pub source_checksum: String,
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub totp: Option<serde_json::Value>,
    #[serde(default)]
    pub single_use: bool,
    #[serde(default)]
    pub thread_grants: Vec<ImportGrant>,
    #[serde(default)]
    pub created_at_ms: Option<i64>,
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
    #[serde(default)]
    pub last_used_at_ms: Option<i64>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportGrant {
    pub v1_thread_id: String,
    #[serde(default)]
    pub granted_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportedItem {
    pub source_id: String,
    pub item_id: Option<String>,
    pub outcome: &'static str,
    /// The domain V2 derived from the URL, for the importer to compare.
    pub domain: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    pub format: &'static str,
    pub imported: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub conflicts: usize,
    pub deleted_in_v2: usize,
    pub items: Vec<ImportedItem>,
}

fn checksum_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn time(value: Option<i64>, fallback: i64) -> i64 {
    value
        .filter(|v| (0..=4_102_444_800_000).contains(v))
        .unwrap_or(fallback)
}

/// Everything about one entry that can be checked without the database.
struct Prepared<'a> {
    entry: &'a ImportEntry,
    name: String,
    tags: Vec<String>,
    login: Login,
    grants: Vec<(String, i64)>,
}
fn prepare(entry: &ImportEntry, now: i64) -> Result<Prepared<'_>> {
    if entry.source_id.is_empty()
        || entry.source_id.len() > 128
        || !entry
            .source_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        || !checksum_valid(&entry.source_checksum)
    {
        return Err(VaultError::Invalid("vault_import_entry_invalid"));
    }
    let login = Login::new(&entry.url, &entry.username, &entry.password, &entry.notes)
        // An unreadable V1 URL keeps its text but is never usable by stored login.
        .or_else(|error| match error {
            VaultError::Invalid("vault_url_invalid") => {
                let mut login = Login::new("", &entry.username, &entry.password, &entry.notes)?;
                login.url = entry.url.trim().to_owned();
                Ok(login)
            }
            other => Err(other),
        })?
        .with_extras(&entry.fields, entry.totp.as_ref())?;
    let threads: Vec<String> = entry
        .thread_grants
        .iter()
        .map(|g| g.v1_thread_id.clone())
        .collect();
    let threads = thread_ids(&threads)?;
    let grants = threads
        .into_iter()
        .map(|t| {
            let at = entry
                .thread_grants
                .iter()
                .find(|g| g.v1_thread_id == t)
                .and_then(|g| g.granted_at_ms);
            (t, time(at, now))
        })
        .collect();
    Ok(Prepared {
        entry,
        name: name(&entry.name)?,
        tags: tags(&entry.tags)?,
        login,
        grants,
    })
}

impl Store {
    pub async fn vault_import(
        &self,
        credential: &str,
        reader: Option<&str>,
        request: &ImportRequest,
    ) -> Result<ImportReport> {
        if request.format != IMPORT_FORMAT || request.source != "v1" {
            return Err(VaultError::Invalid("vault_import_format_invalid"));
        }
        if request.items.is_empty() || request.items.len() > MAX_IMPORT_ITEMS {
            return Err(VaultError::Invalid("vault_import_size_invalid"));
        }
        let now = now_ms();
        let prepared = request
            .items
            .iter()
            .map(|entry| prepare(entry, now))
            .collect::<Result<Vec<_>>>()?;
        for (index, item) in prepared.iter().enumerate() {
            if prepared[..index]
                .iter()
                .any(|other| other.entry.source_id == item.entry.source_id)
            {
                return Err(VaultError::Invalid("vault_import_duplicate_source"));
            }
        }
        let mut tx = self.vault_tx(true).await?;
        let owner = browser_owner(&mut tx, credential).await?;
        let recipients = recipients(&mut tx, &owner, reader).await?;
        let mut report = ImportReport {
            format: IMPORT_REPORT_FORMAT,
            imported: 0,
            updated: 0,
            unchanged: 0,
            conflicts: 0,
            deleted_in_v2: 0,
            items: Vec::with_capacity(prepared.len()),
        };
        for item in &prepared {
            let (item_id, outcome) = import_one(&mut tx, &owner, &recipients, item).await?;
            match outcome {
                "imported" => report.imported += 1,
                "updated" => report.updated += 1,
                "unchanged" => report.unchanged += 1,
                "conflict" => report.conflicts += 1,
                _ => report.deleted_in_v2 += 1,
            }
            if matches!(outcome, "imported" | "updated") {
                let id = item_id.as_deref();
                audit(
                    &mut tx,
                    &owner,
                    "import_applied",
                    Audit {
                        item: id,
                        detail: Some(outcome),
                        ..Default::default()
                    },
                )
                .await?;
            }
            report.items.push(ImportedItem {
                source_id: item.entry.source_id.clone(),
                domain: Some(item.login.domain.clone()),
                item_id,
                outcome,
            });
        }
        tx.commit().await.map_err(db)?;
        Ok(report)
    }
}

async fn import_one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    recipients: &[(String, String)],
    item: &Prepared<'_>,
) -> Result<(Option<String>, &'static str)> {
    let entry = item.entry;
    let mapping: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT source_checksum,item_id,item_revision FROM vault_import_sources WHERE owner_id=? AND source='v1' AND source_id=?",
    )
    .bind(owner.to_string())
    .bind(&entry.source_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let now = now_ms();
    let login_updated = time(entry.updated_at_ms, now);
    let Some((checksum, mapped, written_revision)) = mapping else {
        // Keep the V1 id when it is free: the helper's per-item state uses it.
        let free = item_id_valid(&entry.source_id)
            && sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vault_items WHERE id=?")
                .bind(&entry.source_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(db)?
                == 0;
        let id = if free {
            entry.source_id.clone()
        } else {
            new_item_id()
        };
        let sealed = seal_login(recipients, owner, &id, &item.login)?;
        insert_item(
            tx,
            owner,
            NewItem {
                id: &id,
                name: &item.name,
                tags: &item.tags,
                login: &item.login,
                sealed: &sealed,
                single_use: entry.single_use,
                created_at_ms: time(entry.created_at_ms, now),
                login_updated_at_ms: login_updated,
                last_used_at_ms: entry.last_used_at_ms.map(|t| time(Some(t), now)),
            },
        )
        .await?;
        write_grants(tx, &id, &item.grants).await?;
        sqlx::query("INSERT INTO vault_import_sources(owner_id,source,source_id,source_checksum,item_id,item_revision,imported_at_ms) VALUES(?,'v1',?,?,?,1,?)")
            .bind(owner.to_string()).bind(&entry.source_id).bind(&entry.source_checksum).bind(&id).bind(now)
            .execute(&mut **tx).await.map_err(db)?;
        return Ok((Some(id), "imported"));
    };
    let current = match &mapped {
        Some(id) => sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM vault_items WHERE id=? AND owner_id=?",
        )
        .bind(id)
        .bind(owner.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?,
        None => None,
    };
    let (Some(id), Some(revision)) = (mapped, current) else {
        return Ok((None, "deleted_in_v2"));
    };
    if checksum == entry.source_checksum {
        return Ok((Some(id), "unchanged"));
    }
    if revision != written_revision {
        return Ok((Some(id), "conflict"));
    }
    let sealed = seal_login(recipients, owner, &id, &item.login)?;
    write_login(tx, owner, &id, &item.login, &sealed, login_updated).await?;
    write_grants(tx, &id, &item.grants).await?;
    sqlx::query("UPDATE vault_items SET name=?,tags_json=?,single_use=? WHERE id=? AND owner_id=?")
        .bind(&item.name)
        .bind(serde_json::to_string(&item.tags).map_err(db)?)
        .bind(entry.single_use)
        .bind(&id)
        .bind(owner.to_string())
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    sqlx::query("UPDATE vault_import_sources SET source_checksum=?,item_revision=?,imported_at_ms=? WHERE owner_id=? AND source='v1' AND source_id=?")
        .bind(&entry.source_checksum).bind(revision + 1).bind(now)
        .bind(owner.to_string()).bind(&entry.source_id)
        .execute(&mut **tx).await.map_err(db)?;
    Ok((Some(id), "updated"))
}
