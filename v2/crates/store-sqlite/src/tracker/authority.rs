//! Owner-only override and mailbox provenance policy for tracker grants.
use super::Result;
use crate::conversation_resources::ResourceError;
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};

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
) -> Result<()> {
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
            || super::apply::find(
                tx,
                (&owner.to_string(), &conversation.to_string()),
                event,
                event.link.as_deref(),
            )
            .await?
            .is_none()
        {
            return Err(ResourceError::Invalid);
        }
    }
    Ok(())
}
