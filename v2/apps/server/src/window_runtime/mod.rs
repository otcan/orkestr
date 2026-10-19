//! Always-on API ownership of finite execution windows.
//!
//! Local handles select a transport; only Core's current window and credential
//! fences authorize effects. The root manager independently bounds egress.
mod clock;
pub(crate) mod handles;
mod integers;
