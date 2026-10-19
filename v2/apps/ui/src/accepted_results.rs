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
pub fn bound_payload(row: &AcceptedResult, conversation: &str, payload: &ProviderPayload) -> bool {
    !row.payload_removed
        && payload.conversation_id.to_string() == conversation
        && payload.run_id == row.run_id
        && row.payload_id.as_ref() == Some(&payload.payload_id)
}
