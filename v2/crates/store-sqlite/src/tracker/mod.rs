//! Per-conversation tracker (migration 0074): application rows with an
//! append-only event timeline, URL and company+role dedupe, a processed
//! message ledger and an optional conversation-scoped grant so the
//! conversation's assistant can read the table and record events without
//! owner authority. Nothing here admits input, wakes a provider or sends.
mod apply;
mod edit;
mod merge;
#[cfg(test)]
pub(crate) mod migration_fixture;
mod scan;
mod unresolved;
use crate::conversation_resources::{now_ms, owned, unavailable, ResourceError};
use crate::Store;
pub use apply::UNKNOWN_COMPANY;
use orkestr_v2_contracts::*;
pub use scan::{ScanRecord, ScannedMessage};
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};
use uuid::Uuid;

pub(crate) type Result<T> = std::result::Result<T, ResourceError>;

/// The owner (cookie or bearer), or the conversation's tracker grant
/// (read rows and events, record events, run the mail scan).
#[derive(Clone, Copy)]
pub enum TrackerCaller<'a> {
    Owner {
        credential: &'a str,
        owner: &'a OwnerId,
    },
    Grant(&'a str),
}

pub(crate) const ROW_COLUMNS: &str = "id,company,company_key,role,role_key,source,status,status_changed_ms,applied_ms,last_contact_ms,next_step,link,location,notes,confidence,needs_review,archived,events_count,revision";

fn grant_hash(grant: &str) -> String {
    crate::digest(&format!("orkestr-v2-tracker-grant:{grant}"))
}

pub(crate) fn row_of(row: &SqliteRow) -> Result<TrackerRow> {
    let text = |name: &str| row.try_get::<String, _>(name).map_err(unavailable);
    let int = |name: &str| row.try_get::<i64, _>(name).map_err(unavailable);
    Ok(TrackerRow {
        id: Uuid::parse_str(&text("id")?).map_err(unavailable)?,
        company: text("company")?,
        company_key: text("company_key")?,
        role: text("role")?,
        role_key: text("role_key")?,
        source: text("source")?,
        status: TrackerStatus::parse(&text("status")?).ok_or(ResourceError::Unavailable)?,
        status_changed_ms: int("status_changed_ms")?,
        applied_ms: row.try_get("applied_ms").map_err(unavailable)?,
        last_contact_ms: int("last_contact_ms")?,
        next_step: row.try_get("next_step").map_err(unavailable)?,
        link: row.try_get("link").map_err(unavailable)?,
        location: row.try_get("location").map_err(unavailable)?,
        notes: text("notes")?,
        confidence: u8::try_from(int("confidence")?).map_err(unavailable)?,
        needs_review: int("needs_review")? != 0,
        archived: int("archived")? != 0,
        events_count: u32::try_from(int("events_count")?).map_err(unavailable)?,
        revision: int("revision")?,
    })
}

fn event_of(row: &SqliteRow) -> Result<TrackerEvent> {
    let text = |name: &str| row.try_get::<String, _>(name).map_err(unavailable);
    Ok(TrackerEvent {
        id: Uuid::parse_str(&text("id")?).map_err(unavailable)?,
        row_id: Uuid::parse_str(&text("row_id")?).map_err(unavailable)?,
        kind: TrackerEventKind::parse(&text("kind")?).ok_or(ResourceError::Unavailable)?,
        occurred_ms: row.try_get("occurred_ms").map_err(unavailable)?,
        source: text("source")?,
        message_ref: row.try_get("message_ref").map_err(unavailable)?,
        sender_domain: row.try_get("sender_domain").map_err(unavailable)?,
        evidence: row.try_get("evidence").map_err(unavailable)?,
        classifier: text("classifier")?,
        confidence: u8::try_from(row.try_get::<i64, _>("confidence").map_err(unavailable)?)
            .map_err(unavailable)?,
    })
}

/// The tracker's stored configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerConfig {
    pub recipe: String,
    pub notify_on: Vec<TrackerEventKind>,
    pub grant_issued: bool,
    pub source_json: Option<String>,
    pub source_revision: i64,
    pub cursor_json: Option<String>,
    pub last_scan_ms: Option<i64>,
    pub last_scan_json: Option<String>,
}

pub(crate) async fn config(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<TrackerConfig> {
    let row = sqlx::query(
        "SELECT recipe,notify_on_json,grant_hash,source_json,source_revision,cursor_json,last_scan_ms,last_scan_json FROM trackers WHERE owner_id=? AND conversation_id=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(ResourceError::Conflict("tracker_not_enabled"))?;
    let notify: Vec<String> =
        serde_json::from_str(&row.get::<String, _>("notify_on_json")).map_err(unavailable)?;
    Ok(TrackerConfig {
        recipe: row.get("recipe"),
        notify_on: notify
            .iter()
            .filter_map(|k| TrackerEventKind::parse(k))
            .collect(),
        grant_issued: row.get::<Option<String>, _>("grant_hash").is_some(),
        source_json: row.get("source_json"),
        source_revision: row.get("source_revision"),
        cursor_json: row.get("cursor_json"),
        last_scan_ms: row.get("last_scan_ms"),
        last_scan_json: row.get("last_scan_json"),
    })
}

impl Store {
    /// A transaction scoped to one conversation's tracker for this caller.
    pub(crate) async fn tracker_scope(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
        write: bool,
    ) -> Result<(Transaction<'_, Sqlite>, OwnerId)> {
        match caller {
            TrackerCaller::Owner { credential, owner } => Ok((
                self.owner_scope(credential, owner, conversation, write)
                    .await?,
                owner.clone(),
            )),
            TrackerCaller::Grant(grant) => {
                if self.authority.is_some()
                    || grant.len() != 64
                    || !grant
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(ResourceError::Unauthorized);
                }
                let mut tx = self
                    .pool
                    .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
                    .await
                    .map_err(unavailable)?;
                let owner: Option<String> = sqlx::query_scalar(
                    "SELECT owner_id FROM trackers WHERE conversation_id=? AND grant_hash=?",
                )
                .bind(conversation.to_string())
                .bind(grant_hash(grant))
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?;
                let owner = owner
                    .and_then(|o| Uuid::parse_str(&o).ok())
                    .map(OwnerId)
                    .ok_or(ResourceError::Unauthorized)?;
                owned(&mut tx, &owner, conversation).await?;
                Ok((tx, owner))
            }
        }
    }

    /// Turn the tracker on, or update its recipe and notification set.
    pub async fn enable_tracker(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &TrackerEnable,
    ) -> Result<TrackerConfig> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let notify: Vec<&str> = request.notify_on.iter().map(|k| k.as_str()).collect();
        let now = now_ms();
        sqlx::query(
            "INSERT INTO trackers(owner_id,conversation_id,recipe,notify_on_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?)
             ON CONFLICT(owner_id,conversation_id) DO UPDATE SET recipe=excluded.recipe,notify_on_json=excluded.notify_on_json,updated_ms=excluded.updated_ms",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(&request.recipe)
        .bind(serde_json::to_string(&notify).map_err(unavailable)?)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let value = config(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    pub async fn tracker_page(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
    ) -> Result<TrackerPage> {
        let (mut tx, owner) = self.tracker_scope(caller, conversation, false).await?;
        let config = config(&mut tx, &owner, conversation).await?;
        let rows = sqlx::query(&format!(
            "SELECT {ROW_COLUMNS} FROM tracker_rows WHERE owner_id=? AND conversation_id=? AND NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.owner_id=tracker_rows.owner_id AND m.conversation_id=tracker_rows.conversation_id AND m.absorb_id=tracker_rows.id) ORDER BY last_contact_ms DESC,id LIMIT ?"
        ))
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(TRACKER_ROWS_MAX as i64)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerPage {
            conversation_id: conversation.clone(),
            recipe: config.recipe,
            grant_issued: config.grant_issued,
            last_scan_ms: config.last_scan_ms,
            rows: rows.iter().map(row_of).collect::<Result<_>>()?,
        })
    }

    /// The timeline of one row, oldest first.
    pub async fn tracker_row_events(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
        row: Uuid,
    ) -> Result<Vec<TrackerEvent>> {
        let (mut tx, owner) = self.tracker_scope(caller, conversation, false).await?;
        let events = sqlx::query(
            "WITH RECURSIVE history(row_id) AS (SELECT ? UNION SELECT m.absorb_id FROM tracker_row_merges m JOIN history h ON h.row_id=m.keep_id WHERE m.owner_id=? AND m.conversation_id=?) SELECT id,row_id,kind,occurred_ms,source,message_ref,sender_domain,evidence,classifier,confidence FROM tracker_events
             WHERE owner_id=? AND conversation_id=? AND row_id IN (SELECT row_id FROM history) ORDER BY occurred_ms,recorded_ms,id LIMIT 500",
        )
        .bind(row.to_string())
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        if events.is_empty() {
            return Err(ResourceError::NotFound);
        }
        events.iter().map(event_of).collect()
    }

    /// Issue (rotate) the conversation's tracker grant; shown once, stored hashed.
    pub async fn issue_tracker_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<TrackerGrantIssued> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        config(&mut tx, owner, conversation).await?;
        let grant = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("UPDATE trackers SET grant_hash=?,grant_generation=grant_generation+1,updated_ms=? WHERE owner_id=? AND conversation_id=?")
            .bind(grant_hash(&grant))
            .bind(now_ms())
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TrackerGrantIssued {
            conversation_id: conversation.clone(),
            grant,
        })
    }

    pub async fn revoke_tracker_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<()> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        config(&mut tx, owner, conversation).await?;
        sqlx::query("UPDATE trackers SET grant_hash=NULL,updated_ms=? WHERE owner_id=? AND conversation_id=?")
            .bind(now_ms())
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
