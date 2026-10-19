//! Exact integer JSON transport boundary; JavaScript receives and returns text.
use serde::{de::DeserializeOwned, Serialize};
#[derive(Clone, Copy)]
pub enum MemoryRoute {
    Settings,
    Proposals,
    Decisions,
    Query,
    Export,
}
impl MemoryRoute {
    pub fn path(self) -> &'static str {
        match self {
            Self::Settings => "/api/v2/memory/settings",
            Self::Proposals => "/api/v2/memory/proposals",
            Self::Decisions => "/api/v2/memory/decisions",
            Self::Query => "/api/v2/memory/query",
            Self::Export => "/api/v2/memory/export",
        }
    }
    pub fn response_limit(self) -> usize {
        match self {
            Self::Query => 4 * 1024 * 1024,
            Self::Export => 8 * 1024 * 1024,
            _ => 65536,
        }
    }
}
pub fn body<T: Serialize>(value: &T) -> Result<String, &'static str> {
    let text = serde_json::to_string(value).map_err(|_| "Invalid memory request")?;
    if text.len() > 65536 {
        return Err("Memory request is too large");
    }
    Ok(text)
}
pub fn decode<T: DeserializeOwned>(route: MemoryRoute, text: &str) -> Result<T, &'static str> {
    if text.len() > route.response_limit() {
        return Err("Memory response is too large");
    }
    serde_json::from_str(text).map_err(|_| "Invalid memory response")
}
