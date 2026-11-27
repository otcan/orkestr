//! Desk reservations in Core ([`orkestr_v2_contracts::desk_verdict`] and the
//! rules beside it). Every decision reads them in the transaction of the row
//! it guards: recording an acquire refuses a desk that a reservation holds
//! against the chat and makes or extends the chat's task in the transaction
//! that inserts its lease row, so no grant caller can take a desk between two
//! steps of another chat, while the owner has it, or while the owner views
//! it. A chat sees other chats only by name; the owner's inventory also gets
//! their conversation ids.
use super::desktop_sharing::shared;
use super::desktops::{binding, DesktopCaller};
use super::{now_ms, owned, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};

const SELECT: &str = "SELECT r.desktop_slug,r.kind,r.conversation_id,r.since_ms,r.until_ms,
 coalesce(d.name,'chat-'||substr(r.conversation_id,1,8)) AS chat
 FROM desktop_reservations r
 LEFT JOIN conversation_directory d ON d.conversation_id=r.conversation_id AND d.owner_id=r.owner_id";
/// Desks a chat leased this recently are free-desk candidates.
const RECENT_MS: i64 = 14 * 86_400_000;

/// A desk's claim and owner viewing window that still hold, as one chat sees
/// them.
#[derive(Debug, Default)]
pub(crate) struct DeskReservations {
    pub claim: Option<DesktopReservationView>,
    pub viewer: Option<DesktopReservationView>,
}
impl DeskReservations {
    fn state(self, desk: &str) -> DesktopReservationState {
        let (verdict, holder) = desk_verdict(self.claim.as_ref(), self.viewer.as_ref());
        DesktopReservationState {
            schema_version: 1,
            desk: desk.to_owned(),
            verdict,
            holder,
            reservation: self.claim,
            owner_viewer: self.viewer,
            free_desks: Vec::new(),
        }
    }
}

fn view_of(
    row: &SqliteRow,
    me: Option<&ConversationId>,
    with_ids: bool,
) -> Result<DesktopReservationView> {
    let kind = DesktopReservationKind::parse(row.get::<String, _>("kind").as_str())
        .ok_or(ResourceError::Unavailable)?;
    let id = row
        .get::<Option<String>, _>("conversation_id")
        .map(|c| uuid::Uuid::parse_str(&c).map(ConversationId))
        .transpose()
        .map_err(unavailable)?;
    Ok(DesktopReservationView {
        desk: row.get("desktop_slug"),
        kind,
        chat: row.get("chat"),
        mine: id.is_some() && id.as_ref() == me,
        conversation_id: if with_ids { id } else { None },
        since_ms: row.get("since_ms"),
        until_ms: row.get("until_ms"),
    })
}

pub(crate) async fn desk_reservations(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    slug: &str,
    me: &ConversationId,
    now: i64,
) -> Result<DeskReservations> {
    let rows = sqlx::query(&format!(
        "{SELECT} WHERE r.owner_id=? AND r.desktop_slug=? AND r.until_ms>?"
    ))
    .bind(owner.to_string())
    .bind(slug)
    .bind(now)
    .fetch_all(&mut **tx)
    .await
    .map_err(unavailable)?;
    let mut found = DeskReservations::default();
    for row in &rows {
        let view = view_of(row, Some(me), false)?;
        if view.kind == DesktopReservationKind::OwnerViewer {
            found.viewer = Some(view);
        } else {
            found.claim = Some(view);
        }
    }
    Ok(found)
}

/// Expired rows count as none; the owner's next write removes them.
async fn sweep(tx: &mut Transaction<'_, Sqlite>, owner: &OwnerId, now: i64) -> Result<()> {
    sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND until_ms<=?")
        .bind(owner.to_string())
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// Replaces the desk's claim. Callers have checked, in this transaction, that
/// the claim it replaces is none or the chat's own.
#[allow(clippy::too_many_arguments)]
async fn write_claim(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    slug: &str,
    conversation: &ConversationId,
    kind: DesktopReservationKind,
    since_ms: i64,
    until_ms: i64,
    now: i64,
) -> Result<()> {
    if kind == DesktopReservationKind::OwnerViewer || until_ms <= since_ms {
        return Err(ResourceError::Invalid);
    }
    sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind IN ('task','owner_handoff')")
        .bind(owner.to_string())
        .bind(slug)
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    sqlx::query("INSERT INTO desktop_reservations(owner_id,desktop_slug,kind,conversation_id,since_ms,until_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)")
        .bind(owner.to_string())
        .bind(slug)
        .bind(kind.as_str())
        .bind(conversation.to_string())
        .bind(since_ms)
        .bind(until_ms)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// In the transaction that records an acquire: refuses the desk when a
/// reservation holds it against the chat (`desk_busy`,
/// `desk_handed_to_owner`), else makes or extends the chat's task to
/// [`DESK_TASK_GRACE_MS`] past the lease's end.
pub(crate) async fn guard_and_touch(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    slug: &str,
    now: i64,
    lease_end_ms: i64,
) -> Result<()> {
    sweep(tx, owner, now).await?;
    let found = desk_reservations(tx, owner, slug, conversation, now).await?;
    let (verdict, _) = desk_verdict(found.claim.as_ref(), found.viewer.as_ref());
    if verdict != DeskVerdict::Allowed {
        return Err(ResourceError::Conflict(verdict.code()));
    }
    touch_found(tx, owner, conversation, slug, &found, now, lease_end_ms).await
}

/// After a heartbeat that extended the chat's lease: its task follows.
pub(crate) async fn touch(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    slug: &str,
    now: i64,
    lease_end_ms: i64,
) -> Result<()> {
    sweep(tx, owner, now).await?;
    let found = desk_reservations(tx, owner, slug, conversation, now).await?;
    touch_found(tx, owner, conversation, slug, &found, now, lease_end_ms).await
}

#[allow(clippy::too_many_arguments)]
async fn touch_found(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    slug: &str,
    found: &DeskReservations,
    now: i64,
    lease_end_ms: i64,
) -> Result<()> {
    match touched_task(found.claim.as_ref(), now, lease_end_ms) {
        Some((since, until)) => {
            write_claim(
                tx,
                owner,
                slug,
                conversation,
                DesktopReservationKind::Task,
                since,
                until,
                now,
            )
            .await
        }
        None => Ok(()),
    }
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

    /// The desk as `conversation` sees it, with the verdict for its next
    /// acquire. Free desks are the server's to add.
    pub async fn desktop_reservation(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        slug: &str,
    ) -> Result<DesktopReservationState> {
        if !desktop_slug_valid(slug) {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, owner) = self.desktop_scope(caller, conversation, false).await?;
        let found = desk_reservations(&mut tx, &owner, slug, conversation, now_ms()).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(found.state(slug))
    }

    /// A chat's `reserve`, `handoff`, `handback` or `unreserve` of a desk it
    /// may reach. Only the chat's own claim changes.
    pub async fn change_desktop_reservation(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        slug: &str,
        request: &DesktopReservationRequest,
    ) -> Result<DesktopReservationState> {
        if !desktop_slug_valid(slug) || !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, owner) = self.desktop_scope(caller, conversation, true).await?;
        let bound = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::Conflict("desktop_binding_required"))?;
        if !shared(&mut tx, &owner).await? && !bound.desktop_slugs.iter().any(|s| s == slug) {
            return Err(ResourceError::Conflict("desktop_not_granted"));
        }
        let now = now_ms();
        sweep(&mut tx, &owner, now).await?;
        let found = desk_reservations(&mut tx, &owner, slug, conversation, now).await?;
        match reservation_change(request, found.claim.as_ref(), found.viewer.as_ref(), now)
            .map_err(ResourceError::Conflict)?
        {
            ClaimChange::Keep => {}
            ClaimChange::Remove => {
                sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND conversation_id=? AND kind IN ('task','owner_handoff')")
                    .bind(owner.to_string())
                    .bind(slug)
                    .bind(conversation.to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(unavailable)?;
            }
            ClaimChange::Write {
                kind,
                since_ms,
                until_ms,
            } => {
                write_claim(
                    &mut tx,
                    &owner,
                    slug,
                    conversation,
                    kind,
                    since_ms,
                    until_ms,
                    now,
                )
                .await?
            }
        }
        let after = desk_reservations(&mut tx, &owner, slug, conversation, now).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(after.state(slug))
    }

    /// Free-desk candidates for `conversation` instead of `slug`, in order:
    /// `preferred` (named by the client), the chat's bound desks, then desks
    /// it leased in the last 14 days. Left out: the requested desk, a desk
    /// another chat holds, one handed to or viewed by the owner, one with an
    /// active lease (a step is running there), and (without sharing) one
    /// outside the binding. V1's own leases are the server's to check. Also returns the
    /// chat's V1 thread.
    pub async fn desktop_free_candidates(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        slug: &str,
        preferred: &[String],
    ) -> Result<(String, Vec<String>)> {
        let (mut tx, owner) = self.desktop_scope(caller, conversation, false).await?;
        let bound = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::Conflict("desktop_binding_required"))?;
        let shared = shared(&mut tx, &owner).await?;
        let now = now_ms();
        let recent: Vec<String> = sqlx::query_scalar(
            "SELECT desktop_slug FROM desktop_leases WHERE conversation_id=? AND acquired_at_ms>?
             GROUP BY desktop_slug ORDER BY max(row_sequence) DESC LIMIT 32",
        )
        .bind(conversation.to_string())
        .bind(now - RECENT_MS)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let held: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT desktop_slug,kind,conversation_id FROM desktop_reservations WHERE owner_id=? AND until_ms>?",
        )
        .bind(owner.to_string())
        .bind(now)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let leased: Vec<String> = sqlx::query_scalar(
            "SELECT desktop_slug FROM desktop_leases WHERE owner_id=? AND state='active' AND expires_at_ms>?",
        )
        .bind(owner.to_string())
        .bind(now)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let me = conversation.to_string();
        let mut out: Vec<String> = Vec::new();
        for desk in preferred
            .iter()
            .chain(bound.desktop_slugs.iter())
            .chain(recent.iter())
        {
            if desk == slug || out.contains(desk) || !desktop_slug_valid(desk) {
                continue;
            }
            if !shared && !bound.desktop_slugs.contains(desk) {
                continue;
            }
            let taken = held.iter().any(|(d, kind, holder)| {
                d == desk && (kind != "task" || holder.as_deref() != Some(me.as_str()))
            });
            if taken || leased.contains(desk) {
                continue;
            }
            out.push(desk.clone());
        }
        Ok((bound.v1_thread_id, out))
    }

    /// Every reservation of the owner that still holds, as `conversation`
    /// sees them (no other chat's id).
    pub async fn desktop_reservations(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
    ) -> Result<DesktopReservationList> {
        let (mut tx, owner) = self.desktop_scope(caller, conversation, false).await?;
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
            .map(|row| view_of(row, Some(conversation), false))
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(DesktopReservationList {
            schema_version: 1,
            reservations,
        })
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

    /// The owner opened a viewing link to the desk, valid until `until_ms`
    /// (V1's default lifetime when it gave none, never past the maximum). An
    /// open window is only ever extended. Opened from a chat (`watching`),
    /// the owner watches that chat: unless another chat holds the desk, the
    /// chat's task lasts as long as the window, so it keeps working there.
    pub async fn record_owner_viewer(
        &self,
        credential: &str,
        owner: &OwnerId,
        slug: &str,
        until_ms: Option<i64>,
        watching: Option<&ConversationId>,
    ) -> Result<DesktopReservationView> {
        if !desktop_slug_valid(slug) {
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
        let before: Option<(i64, i64)> = sqlx::query_as(
            "SELECT since_ms,until_ms FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'",
        )
        .bind(owner.to_string())
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let (since, until) = match before {
            Some((since, open)) => (since, open.max(until)),
            None => (now, until),
        };
        sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=? AND kind='owner_viewer'")
            .bind(owner.to_string())
            .bind(slug)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        sqlx::query("INSERT INTO desktop_reservations(owner_id,desktop_slug,kind,conversation_id,since_ms,until_ms,updated_at_ms) VALUES(?,?,'owner_viewer',NULL,?,?,?)")
            .bind(owner.to_string())
            .bind(slug)
            .bind(since)
            .bind(until)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        if let Some(conversation) = watching {
            owned(&mut tx, owner, conversation).await?;
            let found = desk_reservations(&mut tx, owner, slug, conversation, now).await?;
            let task = match &found.claim {
                None => Some((now, until)),
                Some(c) if c.mine && c.kind == DesktopReservationKind::Task => {
                    Some((c.since_ms, c.until_ms.max(until)))
                }
                Some(_) => None,
            };
            if let Some((task_since, task_until)) = task {
                write_claim(
                    &mut tx,
                    owner,
                    slug,
                    conversation,
                    DesktopReservationKind::Task,
                    task_since,
                    task_until,
                    now,
                )
                .await?;
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
        })
    }

    /// The owner frees the desk: its claim and viewing window end now.
    /// Returns how many reservations ended.
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
        let ended =
            sqlx::query("DELETE FROM desktop_reservations WHERE owner_id=? AND desktop_slug=?")
                .bind(owner.to_string())
                .bind(slug)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?
                .rows_affected();
        tx.commit().await.map_err(unavailable)?;
        Ok(ended)
    }
}
