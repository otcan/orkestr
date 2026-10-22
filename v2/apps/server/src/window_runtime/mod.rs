//! Always-on API ownership of finite execution windows.
//!
//! Local handles select a transport; only Core's current window and credential
//! fences authorize effects. The root manager independently bounds egress.
mod auto_accept;
mod clock;
#[cfg(test)]
mod cold_process_tests;
pub(crate) mod context;
mod controller;
mod conversation;
mod dispatch;
pub(crate) mod handles;
pub(crate) mod initial;
mod integers;
pub(crate) mod manager_client;
pub(crate) mod pressure;
pub(crate) use controller::{Controller, ReconcileError, WindowOutcome};

#[cfg(test)]
mod closed_idle_process_tests;
