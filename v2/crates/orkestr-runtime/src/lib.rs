//! Runtime protocols and capability-consuming process transport.
//! FAKE output is synthetic, never acceptance evidence.
pub mod fake;
pub mod ports;
pub mod protocol;
pub mod supervisor;

pub mod broker;
pub mod claude_rpc;
pub mod codex_rpc;
pub mod containment;
pub mod execution;
