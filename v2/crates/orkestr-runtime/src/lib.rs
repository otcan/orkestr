//! Runtime protocols and capability-consuming process transport.
//! FAKE output is synthetic, never acceptance evidence.
pub mod fake;
pub mod ports;
pub mod protocol;
pub mod supervisor;

pub mod broker;
pub mod capacity_fallback;
pub mod claude_rpc;
pub mod codex_rpc;
pub mod containment;
pub mod execution;
pub mod provider_access;
pub mod worker_sandbox;
pub mod workspace_exec;
