#![allow(
    clippy::double_must_use,
    reason = "async-trait 0.1.89 adds redundant must_use to generated futures"
)]
//! Restricted threads for a self-hosted OpenAI-compatible model: the model emits
//! structured action requests; the broker decides, audits and executes them.
pub mod action;
pub mod agent;
pub mod broker;
pub mod exec;
pub mod gpu;
pub mod llm;
pub mod netcheck;
pub mod paths;
pub mod policy;
pub mod sandbox;
pub mod web;

pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
