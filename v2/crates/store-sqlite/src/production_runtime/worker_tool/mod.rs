//! Explicit, bounded offline tool authority; provider dispatch alone cannot launch.
use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};
use sqlx::sqlite::SqliteRow;
use std::sync::atomic::{AtomicBool, Ordering};
mod authority;
mod finish;
mod issuance;
mod types;
use authority::{execution, load, receipt};
pub use types::*;

#[cfg(test)]
mod tests;
