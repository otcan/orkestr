//! Owner-authorized directory observations. Selecting a row never admits work.
use orkestr_v2_contracts::{ConversationId, Scope};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationSummary {
    pub conversation_id: ConversationId,
    pub name: String,
    pub scope: Scope,
    pub last_sequence: i64,
}
impl ConversationSummary {
    pub fn valid(&self) -> bool {
        !self.conversation_id.0.is_nil() && valid_name(&self.name) && self.last_sequence >= 0
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationPage {
    pub conversations: Vec<ConversationSummary>,
    pub next_cursor: Option<i64>,
}
impl ConversationPage {
    pub fn valid(&self, after: i64) -> bool {
        after >= 0
            && self.conversations.len() <= 50
            && self.conversations.iter().all(ConversationSummary::valid)
            && self
                .conversations
                .iter()
                .map(|c| c.conversation_id.to_string())
                .collect::<BTreeSet<_>>()
                .len()
                == self.conversations.len()
            && self
                .next_cursor
                .is_none_or(|next| next > after && !self.conversations.is_empty())
    }
}
pub fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name == name.trim()
        && name.chars().count() <= 120
        && !name.chars().any(char::is_control)
}
#[derive(Clone, Serialize)]
pub struct CreateIntent {
    pub client_request_id: String,
    pub name: String,
}
#[derive(Clone, Default)]
pub struct Creation {
    pub name: String,
    pub pending: Option<CreateIntent>,
}
impl Creation {
    pub fn prepare(&mut self, key: String) -> Result<CreateIntent, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.clone());
        }
        let name = self.name.trim();
        if !valid_name(name)
            || key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
        {
            return Err("Use a name of 1–120 characters without control characters.");
        }
        let request = CreateIntent {
            client_request_id: key,
            name: name.to_string(),
        };
        self.pending = Some(request.clone());
        Ok(request)
    }
    pub fn confirmed(&self, row: &ConversationSummary) -> bool {
        row.valid()
            && row.scope == Scope::Global
            && self.pending.as_ref().is_some_and(|p| p.name == row.name)
    }
}
