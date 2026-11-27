//! The owner's side of desk reservations: the inventory with the holding
//! conversations, the owner's viewing window when a link is opened, and
//! freeing a desk. Owner session only; a chat's desktop grant cannot reach it.
use super::desktop_reservations::{desk_reservations, sweep, view_of, write_claim, Claim, SELECT};
use super::{now_ms, owned, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};

/// A V1 share id: what the owner's viewing window may name, to revoke it.
pub(crate) fn share_id_valid(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Store {
    /// The owner's own session (browser or Bearer), for owner-wide desk rows.
    async fn owner_desk_scope(
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

    /// The owner's inventory: every reservation that still holds, with the
    /// holding conversation's id.
    pub async fn owner_desktop_reservations(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<Vec<DesktopReservationView>> {
        let mut tx = self.owner_desk_scope(credential, owner, false).await?;
        let rows = sqlx::query(&format!(
            "{SELECT} WHERE r.owner_id=? AND r.until_ms>? ORDER BY r.desktop_slug,r.kind LIMIT 1000"
        ))
        .bind(owner.to_string())
        .bind(now_ms())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let reservations = rows
            .iter()
            .map(|row| view_of(row, None, true))
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(reservations)
    }

    /// The owner opened a viewing link to the desk (`share_id` at V1), valid
    /// until `until_ms` (V1's default lifetime when it gave none, never past
    /// the maximum). An open window is only ever extended. Opened from a chat
    /// (`watching`), the owner watches that chat: unless another chat holds
    /// the desk, the chat's task lasts as long as the window, so it keeps
    /// working there.
    pub async fn record_owner_viewer(
        &self,
        credential: &str,
        owner: &OwnerId,
        slug: &str,
        link: (Option<i64>, Option<&str>),
        watching: Option<&ConversationId>,
    ) -> Result<DesktopReservationView> {
        let (until_ms, share_id) = link;
        if !desktop_slug_valid(slug) || share_id.is_some_and(|id| !share_id_valid(id)) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.owner_desk_scope(credential, owner, true).await?;
        let now = now_ms();
        let until = until_ms
            .unwrap_or(now + DESK_VIEWER_DEFAULT_MS)
            .min(now + DESK_VIEWER_MAX_MS);
        if until <= now {
            return Err(ResourceError::Invalid);
        }
        sweep(&mut tx, owner, now).await?;
        let before: Option<(i64, i64, Option<String>)> = sqlx::query_as(
            "SELECT since_ms,until_ms,share_id FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'",
        )
        .bind(owner.to_string())
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let (since, until, share) = match before {
            Some((since, open, old)) => {
                (since, open.max(until), share_id.map(str::to_owned).or(old))
            }
            None => (now, until, share_id.map(str::to_owned)),
        };
        sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'")
            .bind(owner.to_string())
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        sqlx::query("INSERT INTO desktop_reservations(owner_id,desktop_slug,kind,conversation_id,since_ms,until_ms,share_id,updated_at_ms) VALUES(?,?,'owner_viewer',NULL,?,?,?,?)")
            .bind(owner.to_string())
            .bind(slug)
            .bind(since)
            .bind(until)
            .bind(&share)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        if let Some(conversation) = watching {
            owned(&mut tx, owner, conversation).await?;
            let found = desk_reservations(&mut tx, owner, slug, conversation, now).await?;
            let task = match &found.claim {
                None => Some((now, until, None)),
                Some(c) if c.mine && c.kind == DesktopReservationKind::Task => {
                    Some((c.since_ms, c.until_ms.max(until), c.reserved_until_ms))
                }
                Some(_) => None,
            };
            if let Some((since_ms, until_ms, reserved_until_ms)) = task {
                let claim = Claim {
                    conversation,
                    kind: DesktopReservationKind::Task,
                    since_ms,
                    until_ms,
                    reserved_until_ms,
                };
                write_claim(&mut tx, owner, slug, claim, now).await?;
            }
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(DesktopReservationView {
            desk: slug.to_owned(),
            kind: DesktopReservationKind::OwnerViewer,
            chat: None,
            mine: false,
            conversation_id: None,
            since_ms: since,
            until_ms: until,
            reserved_until_ms: None,
        })
    }

    /// The owner frees the desk: the chat's claim on it (a task or a handoff)
    /// ends now. The owner's own viewing window is ended separately
    /// ([`Store::end_owner_viewer`]). Returns how many claims ended.
    pub async fn clear_desktop_reservations(
        &self,
        credential: &str,
        owner: &OwnerId,
        slug: &str,
    ) -> Result<u64> {
        if !desktop_slug_valid(slug) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.owner_desk_scope(credential, owner, true).await?;
        let now = now_ms();
        sweep(&mut tx, owner, now).await?;
        let ended = sqlx::query(
            "DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind IN ('task','owner_handoff')",
        )
        .bind(owner.to_string())
        .bind(slug)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        tx.commit().await.map_err(unavailable)?;
        Ok(ended)
    }

    /// The owner ends viewing the desk: the viewing window ends now. Returns
    /// whether one held and the V1 link it recorded, for the server to revoke.
    pub async fn end_owner_viewer(
        &self,
        credential: &str,
        owner: &OwnerId,
        slug: &str,
    ) -> Result<(bool, Option<String>)> {
        if !desktop_slug_valid(slug) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.owner_desk_scope(credential, owner, true).await?;
        let now = now_ms();
        sweep(&mut tx, owner, now).await?;
        let share: Option<Option<String>> = sqlx::query_scalar(
            "SELECT share_id FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'",
        )
        .bind(owner.to_string())
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'")
            .bind(owner.to_string())
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok((share.is_some(), share.flatten()))
    }
}
