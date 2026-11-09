//! Owner-wide public desk inventory; no tokens, profile paths or endpoints.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopResource {
    pub slug: String,
    pub label: String,
    pub state: String,
    pub lease_state: String,
    pub holder: Option<String>,
    pub expires_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopResourceBinding {
    pub conversation_id: ConversationId,
    pub name: String,
    pub desktop_slugs: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopInventory {
    pub schema_version: u32,
    pub resources: Vec<DesktopResource>,
    pub bindings: Vec<DesktopResourceBinding>,
    pub observed_at_ms: i64,
}
