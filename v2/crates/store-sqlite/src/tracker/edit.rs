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
        TrackerStatus::NoResponse => TrackerEventKind::NoResponse,
    }
}

pub(super) async fn one(
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
        super::merge::ensure_active(&mut tx, owner, conversation, id).await?;
        let mut row = one(&mut tx, owner, conversation, id).await?;
        if row.revision != edit.expected_revision {
            return Err(ResourceError::Conflict("tracker_row_revision_mismatch"));
        }
        let before = row.clone();
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
        let fields: Vec<&str> = [
            ("company", row.company != before.company),
            ("role", row.role != before.role),
            ("link", row.link != before.link),
            ("notes", row.notes != before.notes),
            ("archived", row.archived != before.archived),
            ("next_step", row.next_step != before.next_step),
            ("needs_review", row.needs_review != before.needs_review),
        ]
        .into_iter()
        .filter_map(|(field, changed)| changed.then_some(field))
        .collect();
        if !fields.is_empty() {
            row.events_count += 1;
        }
        row.revision += 1;
        sqlx::query("UPDATE tracker_rows SET company=?,company_key=?,role=?,role_key=?,status=?,status_changed_ms=?,next_step=?,link=?,notes=?,needs_review=?,archived=?,events_count=?,revision=?,updated_ms=? WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(&row.company).bind(&row.company_key).bind(&row.role).bind(&row.role_key)
            .bind(row.status.as_str()).bind(row.status_changed_ms).bind(&row.next_step).bind(&row.link)
            .bind(&row.notes).bind(i64::from(row.needs_review)).bind(i64::from(row.archived))
            .bind(i64::from(row.events_count)).bind(row.revision).bind(now).bind(row.id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
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
        if !fields.is_empty() {
            // Owner content remains in the row; audit keeps field names and hashes only.
            let evidence = serde_json::json!({"fields":fields,
                "before_sha256":crate::digest(&serde_json::to_string(&before).map_err(unavailable)?),
                "after_sha256":crate::digest(&serde_json::to_string(&row).map_err(unavailable)?)}).to_string();
            sqlx::query("INSERT INTO tracker_events(id,owner_id,conversation_id,row_id,kind,occurred_ms,source,classifier,confidence,recorded_ms,evidence) VALUES(?,?,?,?, 'edited',?,'manual','manual',100,?,?)")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string())
                .bind(row.id.to_string()).bind(now).bind(now).bind(evidence)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(row)
    }
}
