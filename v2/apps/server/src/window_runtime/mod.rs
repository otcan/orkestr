//! Always-on API ownership of finite execution windows.
//!
//! Local handles select a transport; only Core's current window and credential
//! fences authorize effects. The root manager independently bounds egress.
mod clock;
#[cfg(test)]
mod cold_process_tests;
pub(crate) mod handles;
pub(crate) mod initial;
mod integers;
