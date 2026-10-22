//! Owner edits from the table view: inline edit of one row (a status edit is
//! recorded as a `manual` event and always wins) and merging two rows.
use super::{row_of, Result, ROW_COLUMNS};
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

/// The event a manual status edit is recorded as.
fn manual_kind(status: TrackerStatus) -> TrackerEventKind {
    match status {
        TrackerStatus::Saved => TrackerEventKind::Saved,
        TrackerStatus::Applied => TrackerEventKind::Applied,
        TrackerStatus::InReview => TrackerEventKind::InReview,
        TrackerStatus::Assessment => TrackerEventKind::Assessment,
        TrackerStatus::Interview => TrackerEventKind::InterviewScheduled,
        TrackerStatus::Offer => TrackerEventKind::Offer,
        TrackerStatus::Rejected => TrackerEventKind::Rejection,
        TrackerStatus::Withdrawn => TrackerEventKind::Withdrawn,
        TrackerStatus::NoResponse => TrackerEventKind::Note,
    }
}

async fn one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    id: Uuid,
) -> Result<TrackerRow> {
    let row = sqlx::query(&format!(
        "SELECT {ROW_COLUMNS} FROM tracker_rows WHERE owner_id=? AND conversation_id=? AND id=?"
    ))
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(id.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(ResourceError::NotFound)?;
    row_of(&row)
}

impl Store {
    pub async fn edit_tracker_row(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: Uuid,
        edit: &TrackerRowEdit,
    ) -> Result<TrackerRow> {
        if !edit.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        super::config(&mut tx, owner, conversation).await?;
        let mut row = one(&mut tx, owner, conversation, id).await?;
        if row.revision != edit.expected_revision {
            return Err(ResourceError::Conflict("tracker_row_revision_mismatch"));
        }
        let now = now_ms();
        if let Some(company) = &edit.company {
            row.company = company.trim().to_owned();
            row.company_key = tracker_company_key(company);
        }
        if let Some(role) = &edit.role {
            row.role = role.trim().to_owned();
            row.role_key = tracker_role_key(role);
        }
        let status_edit = edit.status.filter(|s| *s != row.status);
        if let Some(status) = status_edit {
            row.status = status;
            row.status_changed_ms = now;
            if edit.next_step.is_none() {
                row.next_step = status.default_next_step().map(str::to_owned);
            }
            row.events_count += 1;
        }
        if let Some(step) = &edit.next_step {
            row.next_step = Some(step.trim().to_owned()).filter(|s| !s.is_empty());
        }
        if let Some(link) = &edit.link {
            row.link = tracker_canonical_url(link);
        }
        if let Some(notes) = &edit.notes {
            row.notes = notes.clone();
        }
        if let Some(review) = edit.needs_review {
            row.needs_review = review;
        }
        if let Some(archived) = edit.archived {
            row.archived = archived;
        }
        row.revision += 1;
        sqlx::query("UPDATE tracker_rows SET company=?,company_key=?,role=?,role_key=?,status=?,status_changed_ms=?,next_step=?,link=?,notes=?,needs_review=?,archived=?,events_count=?,revision=?,updated_ms=? WHERE id=?")
            .bind(&row.company).bind(&row.company_key).bind(&row.role).bind(&row.role_key)
            .bind(row.status.as_str()).bind(row.status_changed_ms).bind(&row.next_step).bind(&row.link)
            .bind(&row.notes).bind(i64::from(row.needs_review)).bind(i64::from(row.archived))
            .bind(i64::from(row.events_count)).bind(row.revision).bind(now).bind(row.id.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        if let Some(link) = &row.link {
            sqlx::query("INSERT OR IGNORE INTO tracker_row_links(owner_id,conversation_id,link,row_id) VALUES(?,?,?,?)")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(link).bind(row.id.to_string())
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        if let Some(status) = status_edit {
            sqlx::query("INSERT INTO tracker_events(id,owner_id,conversation_id,row_id,kind,occurred_ms,source,classifier,confidence,recorded_ms,evidence) VALUES(?,?,?,?,?,?,'manual','manual',100,?,?)")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string())
                .bind(row.id.to_string()).bind(manual_kind(status).as_str()).bind(now).bind(now)
                .bind(format!("status set to {}", status.as_str()))
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(row)
    }

    /// Fold `absorb` into `keep`: events and links move, counts add up, the
    /// later contact wins, and `absorb` is deleted. Status stays `keep`'s
    /// unless `absorb` is further along (or terminal).
    pub async fn merge_tracker_rows(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        merge: &TrackerMerge,
    ) -> Result<TrackerRow> {
        if merge.keep == merge.absorb {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let mut keep = one(&mut tx, owner, conversation, merge.keep).await?;
        let absorb = one(&mut tx, owner, conversation, merge.absorb).await?;
        let status = match (keep.status.rank(), absorb.status.rank()) {
            _ if absorb.status.is_terminal() => absorb.status,
            (Some(a), Some(b)) if b > a => absorb.status,
            _ => keep.status,
        };
        if status != keep.status {
            keep.status = status;
            keep.status_changed_ms = keep.status_changed_ms.max(absorb.status_changed_ms);
        }
        keep.applied_ms = match (keep.applied_ms, absorb.applied_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        keep.last_contact_ms = keep.last_contact_ms.max(absorb.last_contact_ms);
        if keep.role.is_empty() {
            keep.role = absorb.role.clone();
            keep.role_key = absorb.role_key.clone();
        }
        keep.link = keep.link.or(absorb.link.clone());
        keep.location = keep.location.or(absorb.location.clone());
        if !absorb.notes.is_empty() {
            keep.notes = if keep.notes.is_empty() {
                absorb.notes.clone()
            } else {
                format!("{}\n{}", keep.notes, absorb.notes)
            }
            .chars()
            .take(TRACKER_NOTES_MAX)
            .collect();
        }
        keep.events_count += absorb.events_count;
        keep.revision += 1;
        let (o, c) = (owner.to_string(), conversation.to_string());
        for sql in [
            "UPDATE tracker_events SET row_id=? WHERE row_id=? AND owner_id=? AND conversation_id=?",
            "UPDATE OR IGNORE tracker_row_links SET row_id=? WHERE row_id=? AND owner_id=? AND conversation_id=?",
            "UPDATE tracker_messages SET row_id=? WHERE row_id=? AND owner_id=? AND conversation_id=?",
        ] {
            sqlx::query(sql)
                .bind(keep.id.to_string()).bind(absorb.id.to_string()).bind(&o).bind(&c)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        sqlx::query("DELETE FROM tracker_row_links WHERE row_id=?")
            .bind(absorb.id.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("DELETE FROM tracker_rows WHERE id=?")
            .bind(absorb.id.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("UPDATE tracker_rows SET role=?,role_key=?,status=?,status_changed_ms=?,applied_ms=?,last_contact_ms=?,link=?,location=?,notes=?,events_count=?,revision=?,updated_ms=? WHERE id=?")
            .bind(&keep.role).bind(&keep.role_key).bind(keep.status.as_str()).bind(keep.status_changed_ms)
            .bind(keep.applied_ms).bind(keep.last_contact_ms).bind(&keep.link).bind(&keep.location)
            .bind(&keep.notes).bind(i64::from(keep.events_count)).bind(keep.revision).bind(now_ms())
            .bind(keep.id.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(keep)
    }
}
