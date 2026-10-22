//! Accepted replies retain canonical provenance, without inventing chat messages.
use orkestr_v2_contracts::{AcceptedResult, AcceptedResults, ProviderPayload};

pub fn valid_page(page: &AcceptedResults, conversation: &str, after: i64) -> bool {
    after >= 0
        && page.is_valid()
        && page.conversation_id.to_string() == conversation
        && page.results.len() <= 20
        && page
            .results
            .iter()
            .all(|row| row.acceptance_sequence > after)
}
/// Pages the chat reads in one refresh before it stops (20 replies each).
pub const CHAT_PAGES: usize = 50;

/// Where a chat refresh starts reading: a live refresh reads everything after
/// the newest reply already shown, so replies the event stream skipped past
/// (it jumps to the journal watermark) still arrive. Otherwise `fallback`.
pub fn refresh_cursor(newest_shown: Option<i64>, live: bool, fallback: i64) -> i64 {
    match newest_shown {
        Some(newest) if live => newest.max(0),
        _ => fallback,
    }
}

/// The chat follows result pages to the newest reply; the history view reads
/// one page at a time. `None` once there is nothing newer to read.
pub fn next_chat_page(page: &AcceptedResults, inline: bool, cursor: i64) -> Option<i64> {
    page.next_after_sequence
        .filter(|next| inline && *next > cursor)
}
pub fn bound_payload(row: &AcceptedResult, conversation: &str, payload: &ProviderPayload) -> bool {
    !row.payload_removed
        && payload.conversation_id.to_string() == conversation
        && payload.run_id == row.run_id
        && row.payload_id.as_ref() == Some(&payload.payload_id)
}
