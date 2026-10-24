//! Owner-only override and mailbox provenance policy for tracker grants.
use super::Result;
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

pub(super) fn valid_intake(event: &TrackerEventInput) -> bool {
    event.is_valid()
        && event.classifier != "manual"
        && event.source != "manual"
        && !matches!(
            event.kind,
            TrackerEventKind::Edited | TrackerEventKind::NoResponse
        )
}

pub(super) async fn grant_events(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    events: &[TrackerEventInput],
) -> Result<Vec<TrackerChange>> {
    let mut changes = Vec::with_capacity(events.len());
    let now = now_ms();
    for event in events {
        // A grant can annotate existing rows, never assert mail provenance or move status.
        if event.kind != TrackerEventKind::Note
            || event.classifier != "assistant"
            || !matches!(event.source.as_str(), "direct" | "assistant")
            || event.requires_thread
            || !event.thread_refs.is_empty()
            || event.message_ref.is_some()
            || event.sender_domain.is_some()
            || event.evidence.is_some()
        {
            return Err(ResourceError::Invalid);
        }
        let link = event.link.as_deref().and_then(tracker_canonical_url);
        let (row, _) = super::lookup::find(
            tx,
            (&owner.to_string(), &conversation.to_string()),
            event,
            link.as_deref(),
        )
        .await?
        .ok_or(ResourceError::Invalid)?;
        let digest = format!(
            "sha256:{}",
            crate::digest(&super::retention::minimized(event)?)
        );
        sqlx::query("INSERT INTO tracker_events(id,owner_id,conversation_id,row_id,kind,occurred_ms,source,evidence,classifier,confidence,recorded_ms) VALUES(?,?,?,?,'note',?,?,?,?,?,?)")
            .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(row.id.to_string())
            .bind(event.occurred_ms.min(now)).bind(&event.source).bind(digest).bind(&event.classifier).bind(i64::from(event.confidence)).bind(now)
            .execute(&mut **tx).await.map_err(unavailable)?;
        changes.push(TrackerChange {
            kind: TrackerChangeKind::Event,
            row_id: Some(row.id),
            company: row.company,
            role: row.role,
            event: TrackerEventKind::Note,
            from: Some(row.status),
            to: Some(row.status),
            notify: false,
        });
    }
    Ok(changes)
}
