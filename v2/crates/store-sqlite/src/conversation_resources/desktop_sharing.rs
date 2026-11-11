//! Owner-level desk sharing (ORK-773). Every authorization it affects reads it
//! in that decision's own transaction, so a change is never half seen.
use super::{now_ms, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::{DesktopSharing, DesktopSharingRequest, OwnerId};
use sqlx::{Row, Sqlite, Transaction};

pub(crate) async fn sharing_state(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
) -> Result<DesktopSharing> {
    let row = sqlx::query(
        "SELECT share_all_desks,revision,updated_at_ms FROM desktop_sharing WHERE owner_id=?",
    )
    .bind(owner.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    Ok(match row {
        Some(row) => DesktopSharing {
            schema_version: 1,
            share_all_desks: row.get::<i64, _>("share_all_desks") == 1,
            revision: row.get("revision"),
            updated_at_ms: Some(row.get("updated_at_ms")),
        },
        None => DesktopSharing::default_off(),
    })
}

pub(crate) async fn shared(tx: &mut Transaction<'_, Sqlite>, owner: &OwnerId) -> Result<bool> {
    Ok(sharing_state(tx, owner).await?.share_all_desks)
}

/// Active leases on a desk their chat's binding does not list. A row past
/// its V2 expiry is ended first, exactly as the next acquire of that desk
/// would end it, so a forgotten row cannot hold the switch on.
async fn leases_outside_bindings(tx: &mut Transaction<'_, Sqlite>, owner: &OwnerId) -> Result<i64> {
    let rows = sqlx::query(
        "SELECT l.row_sequence,l.desktop_slug,l.expires_at_ms,b.desktop_slugs FROM desktop_leases l
         LEFT JOIN desktop_bindings b ON b.conversation_id=l.conversation_id AND b.owner_id=l.owner_id
         WHERE l.owner_id=? AND l.state='active'",
    )
    .bind(owner.to_string())
    .fetch_all(&mut **tx)
    .await
    .map_err(unavailable)?;
    let now = now_ms();
    let mut outside = 0;
    for row in rows {
        let bound: Vec<String> = match row.get::<Option<String>, _>("desktop_slugs") {
            Some(slugs) => serde_json::from_str(&slugs).map_err(unavailable)?,
            None => Vec::new(),
        };
        if bound.contains(&row.get::<String, _>("desktop_slug")) {
            continue;
        }
        if row.get::<i64, _>("expires_at_ms") > now {
            outside += 1;
            continue;
        }
        sqlx::query("UPDATE desktop_leases SET state='lost',ended_at_ms=?,end_reason='expired' WHERE row_sequence=? AND state='active'")
            .bind(now)
            .bind(row.get::<i64, _>("row_sequence"))
            .execute(&mut **tx)
            .await
            .map_err(unavailable)?;
    }
    Ok(outside)
}

impl Store {
    async fn owner_only_scope(
        &self,
        credential: &str,
        owner: &OwnerId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        let sessions: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if sessions != 1 {
            return Err(ResourceError::Unauthorized);
        }
        Ok(tx)
    }

    pub async fn desktop_sharing(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<DesktopSharing> {
        let mut tx = self.owner_only_scope(credential, owner, false).await?;
        let value = sharing_state(&mut tx, owner).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Turning sharing off is refused while a chat holds a desk its binding
    /// does not list: once off, every active lease is one the chat's own
    /// binding allows, the same invariant a binding change keeps.
    pub async fn set_desktop_sharing(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &DesktopSharingRequest,
    ) -> Result<DesktopSharing> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.owner_only_scope(credential, owner, true).await?;
        let current = sharing_state(&mut tx, owner).await?;
        if current.revision != request.expected_revision {
            return Err(ResourceError::Conflict("desktop_sharing_revision_mismatch"));
        }
        if current.share_all_desks
            && !request.share_all_desks
            && leases_outside_bindings(&mut tx, owner).await? > 0
        {
            return Err(ResourceError::Conflict("desktop_shared_lease_active"));
        }
        sqlx::query(
            "INSERT INTO desktop_sharing(owner_id,share_all_desks,revision,updated_at_ms) VALUES(?,?,?,?)
             ON CONFLICT(owner_id) DO UPDATE SET share_all_desks=excluded.share_all_desks,revision=excluded.revision,updated_at_ms=excluded.updated_at_ms",
        )
        .bind(owner.to_string())
        .bind(i64::from(request.share_all_desks))
        .bind(current.revision + 1)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let value = sharing_state(&mut tx, owner).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }
}
