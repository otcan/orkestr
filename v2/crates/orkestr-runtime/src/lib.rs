//! Offline runtime adapters. FAKE output is synthetic, never acceptance evidence.
//! No database, credential access, inference, or external effect authority.
pub mod fake;
pub mod ports;
pub mod protocol;
pub mod supervisor;
