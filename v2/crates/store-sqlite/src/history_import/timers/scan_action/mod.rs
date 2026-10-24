//! Typed mailbox actions: owner selections and durable scan authority are
//! separate from model instructions. No path, credential or provider admission.
#[cfg(test)]
mod action_tests;
mod claim;
mod commit;
mod enable;
#[cfg(test)]
mod enable_tests;
#[cfg(test)]
pub(crate) mod migration_fixture;
#[cfg(test)]
mod result_tests;
mod source;
#[cfg(test)]
mod tests;
mod types;
mod view;
pub use types::*;

use super::{authority::store_clock, *};

fn source_digest(value: &SelectedMailSource) -> Result<String> {
    serde_json::to_string(value)
        .map(|json| hash(&format!("orkestr.tracker.source.v1:{json}")))
        .map_err(unavailable)
}

fn rule_digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
