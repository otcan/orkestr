//! Runtime protocols and capability-consuming process transport.
//! FAKE output is synthetic, never acceptance evidence.
pub mod fake;
pub mod ports;
pub mod protocol;
pub mod supervisor;

pub mod codex_rpc;
// Production registration awaits the reviewed durable fence adapter. The
// consumed-capability bridge is exercised with ordinary Store under tests only.
#[cfg(test)]
pub mod containment;
#[cfg(test)]
mod execution;
