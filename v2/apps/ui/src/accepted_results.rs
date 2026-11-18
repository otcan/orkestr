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

/// Opening a chat reads its replies newest first, in pages of this many: two
/// pages fill the inline window (the chat keeps the newest 100), where a
/// forward read from the start took one request per 20 replies of history.
pub const NEWEST_PAGE: usize = 50;
pub const NEWEST_PAGES: usize = 2;

/// A newest-first page (`?before_sequence=…&limit=50`): this conversation,
/// at most `NEWEST_PAGE` ordered rows, all below `before`, and no forward
/// cursor. A server that answered with a forward page fails this check, and
/// the chat then reads forward from the start as before.
pub fn valid_newest_page(page: &AcceptedResults, conversation: &str, before: i64) -> bool {
    before >= 1
        && page.is_valid()
        && page.conversation_id.to_string() == conversation
        && page.results.len() <= NEWEST_PAGE
        && page.next_after_sequence.is_none()
        && page
            .results
            .iter()
            .all(|row| row.acceptance_sequence < before)
}

/// The cursor of the next older page: only below a full page.
pub fn older_cursor(page: &AcceptedResults) -> Option<i64> {
    if page.results.len() < NEWEST_PAGE {
        return None;
    }
    page.results.first().map(|row| row.acceptance_sequence)
}

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
