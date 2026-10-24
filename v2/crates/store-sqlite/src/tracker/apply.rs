//! Record events using the dedupe ledger, job links, company and role keys,
//! monotonic status and a resulting changeset. Role-less mail can match a
//! known company after its thread and link references have been considered.
use super::{config, row_of, Result, TrackerCaller, ROW_COLUMNS};
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::*;
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use std::collections::BTreeSet;
use uuid::Uuid;

/// Company name the mail classifier uses when it could not extract one.
pub const UNKNOWN_COMPANY: &str = "Unknown company";
/// Below this confidence a row asks for review.
const REVIEW_BELOW: u8 = 70;

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

async fn load(
    tx: &mut Transaction<'_, Sqlite>,
    sql: &str,
    binds: &[&str],
) -> Result<Vec<TrackerRow>> {
    let mut query = sqlx::query(sql);
    for value in binds {
        query = query.bind(*value);
    }
    let rows = query.fetch_all(&mut **tx).await.map_err(unavailable)?;
    rows.iter().map(row_of).collect()
}

/// Find the row this event belongs to; `true` when the match is ambiguous.
async fn find(
    tx: &mut Transaction<'_, Sqlite>,
    scope: (&str, &str),
    event: &TrackerEventInput,
    link: Option<&str>,
) -> Result<Option<(TrackerRow, bool)>> {
    let (owner, conversation) = scope;
    // A reply in a known thread belongs to that row, whatever it says.
    for reference in &event.thread_refs {
        let found = load(
            tx,
            &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE id=(SELECT row_id FROM tracker_messages WHERE owner_id=? AND conversation_id=? AND message_ref=?)"),
            &[owner, conversation, reference],
        )
        .await?;
        if let Some(row) = found.into_iter().next() {
            return Ok(Some((row, false)));
        }
    }
    if event.requires_thread {
        return Ok(None);
    }
    if let Some(link) = link {
        let found = load(
            tx,
            &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE id=(SELECT row_id FROM tracker_row_links WHERE owner_id=? AND conversation_id=? AND link=?)"),
            &[owner, conversation, link],
        )
        .await?;
        if let Some(row) = found.into_iter().next() {
            return Ok(Some((row, false)));
        }
    }
    let company = tracker_company_key(&event.company);
    if company.is_empty() || event.company == UNKNOWN_COMPANY {
        return Ok(None);
    }
    let role = event
        .role
        .as_deref()
        .map(tracker_role_key)
        .unwrap_or_default();
    if !role.is_empty() {
        let exact = load(
            tx,
            &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE owner_id=? AND conversation_id=? AND company_key=? AND role_key=? ORDER BY last_contact_ms DESC LIMIT 1"),
            &[owner, conversation, &company, &role],
        )
        .await?;
        if let Some(row) = exact.into_iter().next() {
            return Ok(Some((row, false)));
        }
        if event.kind == TrackerEventKind::JobAlert {
            return Ok(None);
        }
    }
    // Same company (one key may extend the other: "acme" / "acme-robotics").
    let candidates = load(
        tx,
        &format!("SELECT {ROW_COLUMNS} FROM tracker_rows WHERE owner_id=? AND conversation_id=? AND archived=0
                  AND (company_key=?1 OR company_key LIKE ?1 || '-%' OR ?1 LIKE company_key || '-%') ORDER BY last_contact_ms DESC")
            .replace("?1", "?3"),
        &[owner, conversation, &company],
    )
    .await?;
    if !role.is_empty() {
        // A role for a row that had none yet ("your application to Acme").
        let open: Vec<TrackerRow> = candidates
            .into_iter()
            .filter(|r| r.role_key.is_empty())
            .collect();
        return Ok((open.len() == 1).then(|| (open.into_iter().next().unwrap(), false)));
    }
    let open: Vec<&TrackerRow> = candidates
        .iter()
        .filter(|r| !r.status.is_terminal())
        .collect();
    Ok(match open.len() {
        1 => Some((open[0].clone(), false)),
        0 => candidates.into_iter().next().map(|r| (r, false)),
        _ => Some((open[0].clone(), true)),
    })
}

fn applied_kind(kind: TrackerEventKind) -> bool {
    matches!(
        kind,
        TrackerEventKind::Applied | TrackerEventKind::ApplicationReceived
    )
}

/// Apply one validated event inside the caller's transaction.
pub(crate) async fn apply_one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    notify_on: &[TrackerEventKind],
    event: &TrackerEventInput,
) -> Result<TrackerChange> {
    let (owner_s, conv_s) = (owner.to_string(), conversation.to_string());
    let link = event.link.as_deref().and_then(tracker_canonical_url);
    let manual = event.classifier == "manual";
    let now = now_ms();
    let matched = find(tx, (&owner_s, &conv_s), event, link.as_deref()).await?;
    let notify = notify_on.contains(&event.kind);
    if matched.is_none() && event.requires_thread {
        super::unresolved::save(tx, owner, conversation, event).await?;
        return Ok(TrackerChange {
            kind: TrackerChangeKind::Unmatched,
            row_id: None,
            company: event.company.clone(),
            role: event.role.clone().unwrap_or_default(),
            event: event.kind,
            from: None,
            to: None,
            notify: false,
        });
    }
    let (row, change) = match matched {
        None => {
            let active: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_rows r WHERE r.owner_id=? AND r.conversation_id=? AND NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id AND m.absorb_id=r.id)")
                .bind(&owner_s).bind(&conv_s).fetch_one(&mut **tx).await.map_err(unavailable)?;
            if active >= TRACKER_ROWS_MAX as i64 {
                return Err(ResourceError::Conflict("tracker_full"));
            }
            let status = event.kind.status().unwrap_or(TrackerStatus::Saved);
            let unknown =
                event.company == UNKNOWN_COMPANY || tracker_company_key(&event.company).is_empty();
            let role = event.role.clone().unwrap_or_default();
            let row = TrackerRow {
                id: Uuid::new_v4(),
                company: event.company.trim().to_owned(),
                company_key: tracker_company_key(&event.company),
                role_key: tracker_role_key(&role),
                role,
                source: event.source.clone(),
                status,
                status_changed_ms: event.occurred_ms,
                applied_ms: applied_kind(event.kind).then_some(event.occurred_ms),
                last_contact_ms: event.occurred_ms,
                next_step: event
                    .next_step
                    .clone()
                    .or(status.default_next_step().map(str::to_owned)),
                link: link.clone(),
                location: event.location.clone(),
                notes: String::new(),
                confidence: event.confidence,
                needs_review: unknown || event.confidence < REVIEW_BELOW,
                archived: false,
                events_count: 1,
                revision: 1,
            };
            sqlx::query(&format!(
                "INSERT INTO tracker_rows(owner_id,conversation_id,{ROW_COLUMNS},created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            ))
            .bind(&owner_s).bind(&conv_s)
            .bind(row.id.to_string()).bind(&row.company).bind(&row.company_key).bind(&row.role).bind(&row.role_key)
            .bind(&row.source).bind(row.status.as_str()).bind(row.status_changed_ms).bind(row.applied_ms)
            .bind(row.last_contact_ms).bind(&row.next_step).bind(&row.link).bind(&row.location).bind(&row.notes)
            .bind(i64::from(row.confidence)).bind(i64::from(row.needs_review)).bind(i64::from(row.archived))
            .bind(i64::from(row.events_count)).bind(row.revision).bind(now).bind(now)
            .execute(&mut **tx).await.map_err(unavailable)?;
            let change = TrackerChange {
                kind: TrackerChangeKind::Created,
                row_id: Some(row.id),
                company: row.company.clone(),
                role: row.role.clone(),
                event: event.kind,
                from: None,
                to: Some(status),
                notify,
            };
            (row, change)
        }
        Some((mut row, ambiguous)) => {
            let before = row.clone();
            let (mut status, mut review) = match (manual, event.kind.status()) {
                (true, Some(status)) => (status, false),
                _ => tracker_transition(row.status, event.kind),
            };
            // Older mail never closes a row that moved on since.
            if status != row.status
                && status.is_terminal()
                && event.occurred_ms < row.status_changed_ms
                && !manual
            {
                status = row.status;
                review = true;
            }
            let changed = status != row.status;
            if changed {
                row.status = status;
                row.status_changed_ms = event.occurred_ms.max(row.status_changed_ms);
                row.next_step = event
                    .next_step
                    .clone()
                    .or(status.default_next_step().map(str::to_owned));
            } else if event.next_step.is_some() {
                row.next_step = event.next_step.clone();
            }
            row.last_contact_ms = row.last_contact_ms.max(event.occurred_ms);
            if row.applied_ms.is_none() && applied_kind(event.kind) {
                row.applied_ms = Some(event.occurred_ms);
            }
            if row.role.is_empty() && event.kind != TrackerEventKind::JobAlert {
                if let Some(role) = event.role.as_ref().filter(|r| !r.trim().is_empty()) {
                    row.role = role.clone();
                    row.role_key = tracker_role_key(role);
                }
            }
            if row.location.is_none() {
                row.location = event.location.clone();
            }
            if row.link.is_none() {
                row.link = link.clone();
            }
            row.confidence = event.confidence;
            row.needs_review |= review || ambiguous || event.confidence < REVIEW_BELOW;
            row.events_count += 1;
            row.revision += 1;
            sqlx::query("UPDATE tracker_rows SET role=?,role_key=?,status=?,status_changed_ms=?,applied_ms=?,last_contact_ms=?,next_step=?,link=?,location=?,confidence=?,needs_review=?,events_count=?,revision=?,updated_ms=? WHERE id=?")
                .bind(&row.role).bind(&row.role_key).bind(row.status.as_str()).bind(row.status_changed_ms)
                .bind(row.applied_ms).bind(row.last_contact_ms).bind(&row.next_step).bind(&row.link).bind(&row.location)
                .bind(i64::from(row.confidence)).bind(i64::from(row.needs_review)).bind(i64::from(row.events_count))
                .bind(row.revision).bind(now).bind(row.id.to_string())
                .execute(&mut **tx).await.map_err(unavailable)?;
            let kind = if changed {
                TrackerChangeKind::StatusChanged
            } else if row.needs_review && !before.needs_review {
                TrackerChangeKind::NeedsReview
            } else {
                TrackerChangeKind::Event
            };
            let change = TrackerChange {
                kind,
                row_id: Some(row.id),
                company: row.company.clone(),
                role: row.role.clone(),
                event: event.kind,
                from: Some(before.status),
                to: Some(row.status),
                notify: notify && changed,
            };
            (row, change)
        }
    };
    if let Some(link) = &link {
        sqlx::query("INSERT OR IGNORE INTO tracker_row_links(owner_id,conversation_id,link,row_id) VALUES(?,?,?,?)")
            .bind(&owner_s).bind(&conv_s).bind(link).bind(row.id.to_string())
            .execute(&mut **tx).await.map_err(unavailable)?;
    }
    if let Some(reference) = &event.message_ref {
        sqlx::query("INSERT OR IGNORE INTO tracker_messages(owner_id,conversation_id,message_ref,row_id) VALUES(?,?,?,?)")
            .bind(&owner_s).bind(&conv_s).bind(reference).bind(row.id.to_string())
            .execute(&mut **tx).await.map_err(unavailable)?;
    }
    sqlx::query("INSERT INTO tracker_events(id,owner_id,conversation_id,row_id,kind,occurred_ms,source,message_ref,sender_domain,evidence,classifier,confidence,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(Uuid::new_v4().to_string()).bind(&owner_s).bind(&conv_s).bind(row.id.to_string())
        .bind(event.kind.as_str()).bind(event.occurred_ms).bind(&event.source).bind(&event.message_ref)
        .bind(&event.sender_domain).bind(&event.evidence).bind(&event.classifier).bind(i64::from(event.confidence))
        .bind(now)
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(change)
}

/// Message references already recorded (before this batch).
pub(crate) async fn ledger_has(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    message_ref: &str,
) -> Result<bool> {
    let found: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_ledger WHERE owner_id=? AND conversation_id=? AND message_ref=?")
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(message_ref)
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)?;
    Ok(found > 0)
}

pub(crate) async fn ledger_record(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    message_ref: &str,
    outcome: &str,
) -> Result<()> {
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=? AND message_ref=? AND state='pending'")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(message_ref)
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    let outcome = if outcome == "event" && pending != 0 {
        "unresolved"
    } else {
        outcome
    };
    sqlx::query("INSERT OR IGNORE INTO tracker_ledger(owner_id,conversation_id,message_ref,outcome,recorded_ms) VALUES(?,?,?,?,?)")
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(message_ref)
        .bind(outcome.chars().take(80).collect::<String>())
        .bind(now_ms())
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    Ok(())
}

/// Apply events in order; events whose message was recorded before are
/// reported as duplicates (several events of one alert share a reference).
pub(crate) async fn apply_events(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    notify_on: &[TrackerEventKind],
    events: &[TrackerEventInput],
) -> Result<Vec<TrackerChange>> {
    let mut known = BTreeSet::new();
    for reference in events.iter().filter_map(|e| e.message_ref.as_deref()) {
        if ledger_has(tx, owner, conversation, reference).await? {
            known.insert(reference.to_owned());
        }
    }
    let mut changes = Vec::with_capacity(events.len());
    for event in events {
        if event
            .message_ref
            .as_ref()
            .is_some_and(|r| known.contains(r))
        {
            changes.push(TrackerChange {
                kind: TrackerChangeKind::Duplicate,
                row_id: None,
                company: event.company.clone(),
                role: event.role.clone().unwrap_or_default(),
                event: event.kind,
                from: None,
                to: None,
                notify: false,
            });
            continue;
        }
        changes.push(apply_one(tx, owner, conversation, notify_on, event).await?);
    }
    for reference in events.iter().filter_map(|e| e.message_ref.as_deref()) {
        ledger_record(tx, owner, conversation, reference, "event").await?;
    }
    Ok(changes)
}

impl Store {
    /// Record a batch of events (the assistant, the UI, an importer).
    /// Idempotent by `request_key`; a different batch under the same key is
    /// `tracker_batch_conflict`.
    pub async fn apply_tracker_events(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
        request: &TrackerEventsRequest,
    ) -> Result<TrackerChangeset> {
        if !valid_key(&request.request_key)
            || request.events.is_empty()
            || request.events.len() > TRACKER_EVENTS_PER_REQUEST
            || !request.events.iter().all(TrackerEventInput::is_valid)
        {
            return Err(ResourceError::Invalid);
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request.events).map_err(unavailable)?)
        );
        let (mut tx, owner) = self.tracker_scope(caller, conversation, true).await?;
        let config = config(&mut tx, &owner, conversation).await?;
        let previous: Option<(String, String)> = sqlx::query_as(
            "SELECT digest,changes_json FROM tracker_batches WHERE owner_id=? AND conversation_id=? AND request_key=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(&request.request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some((stored, changes)) = previous {
            tx.commit().await.map_err(unavailable)?;
            if stored != digest {
                return Err(ResourceError::Conflict("tracker_batch_conflict"));
            }
            return serde_json::from_str(&changes).map_err(unavailable);
        }
        let mut changes = apply_events(
            &mut tx,
            &owner,
            conversation,
            &config.notify_on,
            &request.events,
        )
        .await?;
        changes.extend(
            super::unresolved::reconsider(&mut tx, &owner, conversation, &config.notify_on).await?,
        );
        let set = TrackerChangeset { changes };
        sqlx::query("INSERT INTO tracker_batches(owner_id,conversation_id,request_key,digest,changes_json,created_ms) VALUES(?,?,?,?,?,?)")
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .bind(&request.request_key)
            .bind(&digest)
            .bind(serde_json::to_string(&set).map_err(unavailable)?)
            .bind(now_ms())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(set)
    }
}
