//! Explicit workspace shell authority, separate from provider and offline Python grants.
use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};
use sqlx::sqlite::SqliteRow;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
mod profile;
pub use profile::WorkspaceExecProfile;
mod authority;
mod finish;
mod issuance;
mod native_delivery;
pub use native_delivery::*;
mod native_request;
pub use native_request::WorkspaceExecNativeRequestId;
mod retained_parent;
pub use retained_parent::WorkspaceExecParent;
mod types;
use authority::{execution, load, receipt};
pub use types::*;

#[cfg(test)]
mod tests;
