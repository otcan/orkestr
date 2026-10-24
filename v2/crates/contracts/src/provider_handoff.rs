//! Explicit owner permission for a fresh provider session with carried context.
//! This request authorizes no input, run, replay or delivery.
use crate::{ConversationId, ConversationProvider, ConversationSettingsUpdate};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const HANDOFF_HISTORY_SUMMARY_MAX: usize = 16 * 1024;

// No Debug: the owner-provided historical context may contain private text.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderHandoffRequest {
    pub request_key: String,
    pub window_id: Uuid,
    pub generation: u64,
    pub expected_settings_revision: i64,
    pub target_provider: ConversationProvider,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub acknowledge_new_native_session: bool,
    pub history_summary: String,
}

impl ProviderHandoffRequest {
    pub fn is_valid(&self) -> bool {
        !self.request_key.is_empty()
            && self.request_key.len() <= 128
            && self
                .request_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
            && !self.window_id.is_nil()
            && self.generation > 0
            && self.generation < 9_007_199_254_740_992
            && self.acknowledge_new_native_session
            && !self.history_summary.trim().is_empty()
            && self.history_summary.len() <= HANDOFF_HISTORY_SUMMARY_MAX
            && !self.history_summary.contains('\0')
            && ConversationSettingsUpdate {
                expected_revision: self.expected_settings_revision,
                provider: self.target_provider,
                model: self.model.clone(),
                reasoning_effort: self.reasoning_effort.clone(),
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: false,
            }
            .is_valid()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderHandoffReceipt {
    pub handoff_id: Uuid,
    pub conversation_id: ConversationId,
    pub window_id: Uuid,
    pub generation: u64,
    pub from_provider: ConversationProvider,
    pub to_provider: ConversationProvider,
    pub settings_revision: i64,
    pub provider_generation: i64,
    pub history_sha256: String,
    pub created_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ProviderHandoffRequest {
        ProviderHandoffRequest {
            request_key: "synthetic:handoff".into(),
            window_id: Uuid::from_u128(1),
            generation: 1,
            expected_settings_revision: 0,
            target_provider: ConversationProvider::Codex,
            model: Some("synthetic-model".into()),
            reasoning_effort: Some("high".into()),
            acknowledge_new_native_session: true,
            history_summary: "Synthetic prior decisions; history only, no tasks to replay.".into(),
        }
    }

    #[test]
    fn handoff_requires_explicit_opt_in_and_bounded_context() {
        let mut r = request();
        assert!(r.is_valid());
        r.acknowledge_new_native_session = false;
        assert!(!r.is_valid());
        r = request();
        r.history_summary.clear();
        assert!(!r.is_valid());
        r = request();
        r.history_summary = "x".repeat(HANDOFF_HISTORY_SUMMARY_MAX + 1);
        assert!(!r.is_valid());
        r = request();
        r.history_summary = "é".repeat(HANDOFF_HISTORY_SUMMARY_MAX / 2 + 1);
        assert!(!r.is_valid(), "the summary bound counts UTF-8 bytes");
        r = request();
        r.model = Some("fable".into());
        assert!(!r.is_valid());
        r = request();
        r.history_summary = "private\0text".into();
        assert!(!r.is_valid());
        r = request();
        r.reasoning_effort = Some("unknown".into());
        assert!(!r.is_valid());
        r = request();
        r.expected_settings_revision = -1;
        assert!(!r.is_valid());
        r = request();
        r.generation = 1 << 53;
        assert!(!r.is_valid());
    }

    #[test]
    fn handoff_missing_opt_in_and_unknown_fields_refuse() {
        let mut value = serde_json::to_value(request()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("acknowledge_new_native_session");
        assert!(serde_json::from_value::<ProviderHandoffRequest>(value).is_err());
        let mut value = serde_json::to_value(request()).unwrap();
        value["resume_native_id"] = "synthetic-forbidden".into();
        assert!(serde_json::from_value::<ProviderHandoffRequest>(value).is_err());
    }
}
