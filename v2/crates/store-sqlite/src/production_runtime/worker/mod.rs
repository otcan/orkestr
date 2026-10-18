//! Independent provider Worker authority, distinct from subordinate tool grants.
//! Delegation and non-inbox admission resolve the trusted parent inside the
//! transaction; every unseen operation revalidates its immutable parent lineage.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, RunId, SessionId};
mod admission;
mod delegation;
mod parent;
mod types;
pub use types::*;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod dispatch_tests;
