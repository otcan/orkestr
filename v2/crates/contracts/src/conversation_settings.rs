//! Per-conversation controls with V1 thread parity: provider (Codex/Claude),
//! model, reasoning effort, `NO_REPLY` handling and reply prefix/footer.
//! Settings are owner preferences. They grant no execution authority; a
//! provider change takes effect at the next turn boundary with a new
//! `provider_generation`, never by mutating a running session.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const SETTINGS_MODEL_MAX: usize = 120;
pub const SETTINGS_PREFIX_MAX: usize = 64;
pub const SETTINGS_FOOTER_MAX: usize = 512;
pub const SETTINGS_RENDER_MAX: usize = 64 * 1024;
/// The exact whole-message sentinel (after trimming) that requests silence.
pub const NO_REPLY: &str = "NO_REPLY";

/// V1 `codexReasoningEffort` values (`codex-app-server-common.js`).
pub const CODEX_EFFORTS: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
/// V1 `claudeEffort` values (`claude-settings-command.js`).
pub const CLAUDE_EFFORTS: [&str; 4] = ["low", "medium", "high", "max"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationProvider {
    #[default]
    Codex,
    Claude,
}
impl ConversationProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }
    pub fn efforts(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &CODEX_EFFORTS,
            Self::Claude => &CLAUDE_EFFORTS,
        }
    }
}

/// Full replacement of the owner-editable settings, guarded by revision.
/// `expected_revision` is 0 when the conversation still uses defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationSettingsUpdate {
    pub expected_revision: i64,
    pub provider: ConversationProvider,
    /// `None` uses the installation's provider default model.
    #[serde(default)]
    pub model: Option<String>,
    /// `None` uses the provider default effort.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// When true (V1 behaviour) an exact `NO_REPLY` answer is never delivered.
    pub honor_no_reply: bool,
    #[serde(default)]
    pub reply_prefix: Option<String>,
    #[serde(default)]
    pub reply_footer: Option<String>,
    /// When true, proposals wait for an explicit owner "Accept". The default
    /// (false) auto-accepts owner turns like V1; see `ConversationSettings`.
    #[serde(default)]
    pub review_before_accepting: bool,
    /// Deep burst grouping switch. `None` keeps the current value, so a
    /// model or provider change never re-enables a disabled switch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deep_grouping: Option<bool>,
    /// Owner opt-in to read-only parallel Deep turns (docs/v2/parallel-deep.md).
    /// `None` (omitted) keeps the current value, so a provider, model or
    /// decoration update never turns parallel Deep on or off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel_deep: Option<bool>,
}

fn model_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SETTINGS_MODEL_MAX
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        && !value.bytes().all(|b| b.is_ascii_digit())
        && !["openai", "azure", "openrouter"].contains(&value.to_ascii_lowercase().as_str())
        && !crate::model_denied(value)
}
fn decoration_valid(value: &str, max: usize, newlines: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && !(newlines && c == '\n'))
}

impl ConversationSettingsUpdate {
    pub fn is_valid(&self) -> bool {
        self.expected_revision >= 0
            && self.model.as_deref().is_none_or(model_valid)
            && self
                .reasoning_effort
                .as_deref()
                .is_none_or(|e| self.provider.efforts().contains(&e))
            && self
                .reply_prefix
                .as_deref()
                .is_none_or(|p| decoration_valid(p, SETTINGS_PREFIX_MAX, false))
            && self
                .reply_footer
                .as_deref()
                .is_none_or(|f| decoration_valid(f, SETTINGS_FOOTER_MAX, true))
    }
}

/// Current settings. `revision` 0 means defaults were never changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationSettings {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub revision: i64,
    pub provider: ConversationProvider,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub honor_no_reply: bool,
    pub reply_prefix: Option<String>,
    pub reply_footer: Option<String>,
    /// Increments on every provider switch. A runtime that started its session
    /// under an older generation must finish its turn and start the next turn
    /// on the selected provider with a one-time handoff (V1 `orkestr switch`).
    pub provider_generation: i64,
    pub updated_at_ms: Option<i64>,
    /// Owner delegation of acceptance. False (the default, V1 behaviour): the
    /// server (a system principal authorized by this setting and the live
    /// window's private credential, audited as `auto_accept`) accepts each
    /// completed Worker, Fast and Deep proposal of this conversation on the
    /// owner's behalf. True: proposals wait for a manual "Accept".
    #[serde(default)]
    pub review_before_accepting: bool,
    /// Deep burst grouping (default on): owner inputs that queued while a
    /// Deep turn was busy are answered together by the next Deep turn (at
    /// most 12, within a byte budget). Off: one Deep turn per input, as
    /// before. Read live at each Deep admission.
    #[serde(default = "deep_grouping_default")]
    pub deep_grouping: bool,
    /// Owner opt-in (default off): while the conversation's Deep turn is
    /// running, a queued owner chat input may be answered by a read-only
    /// parallel Deep turn (docs/v2/parallel-deep.md). Serialized only while
    /// on, so the default response shape is unchanged.
    #[serde(default, skip_serializing_if = "is_false")]
    pub parallel_deep: bool,
}
fn deep_grouping_default() -> bool {
    true
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl ConversationSettings {
    pub fn defaults(conversation_id: ConversationId) -> Self {
        Self {
            schema_version: 1,
            conversation_id,
            revision: 0,
            provider: ConversationProvider::Codex,
            model: None,
            reasoning_effort: None,
            honor_no_reply: true,
            reply_prefix: None,
            reply_footer: None,
            provider_generation: 0,
            updated_at_ms: None,
            review_before_accepting: false,
            deep_grouping: true,
            parallel_deep: false,
        }
    }

    /// Canonical outbound formatting for a final assistant answer.
    pub fn render_reply(&self, text: &str) -> RenderedReply {
        if self.honor_no_reply && is_no_reply(text) {
            return RenderedReply::Suppressed {
                reason: SuppressedReason::NoReply,
            };
        }
        if text.trim().is_empty() {
            return RenderedReply::Suppressed {
                reason: SuppressedReason::Empty,
            };
        }
        let mut out = match self.reply_prefix.as_deref() {
            Some(prefix) if !starts_with_ignore_case(text.trim_start(), prefix) => {
                format!("{prefix} {text}")
            }
            _ => text.to_owned(),
        };
        if let Some(footer) = self.reply_footer.as_deref() {
            out.push_str("\n\n");
            out.push_str(footer);
        }
        RenderedReply::Deliver { text: out }
    }
}

/// Launch parameters a runtime applies when it starts a Deep or Worker turn.
/// Read in the same transaction that consumes the dispatch, so a change
/// applies from the next turn and never mutates a running one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnLaunch {
    pub settings_revision: i64,
    pub provider: ConversationProvider,
    pub provider_generation: i64,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}
impl TurnLaunch {
    /// `turn/start` `model`/`effort` overrides for a Codex turn (V1
    /// `turnStartParams`). None when the conversation selected another
    /// provider: its model and effort must never be sent to Codex.
    pub fn codex_overrides(&self) -> Option<(Option<&str>, Option<&str>)> {
        (self.provider == ConversationProvider::Codex)
            .then_some((self.model.as_deref(), self.reasoning_effort.as_deref()))
    }
    /// Whether a turn on `running` must first switch provider (V1 switch
    /// at a turn boundary with a one-time handoff).
    pub fn requires_switch_from(&self, running: ConversationProvider) -> bool {
        self.provider != running
    }
}
/// Model names accepted on the wire (same rule as settings).
pub fn launch_model_valid(value: &str) -> bool {
    model_valid(value)
}
impl ConversationSettings {
    pub fn launch(&self) -> TurnLaunch {
        TurnLaunch {
            settings_revision: self.revision,
            provider: self.provider,
            provider_generation: self.provider_generation,
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
        }
    }
}

/// V1 `no-reply.js`: trimmed, case-sensitive, whole-message match.
pub fn is_no_reply(text: &str) -> bool {
    text.trim() == NO_REPLY
}
fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.is_char_boundary(prefix.len())
        && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuppressedReason {
    NoReply,
    Empty,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum RenderedReply {
    Deliver { text: String },
    Suppressed { reason: SuppressedReason },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderReplyRequest {
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderReplyResponse {
    pub settings_revision: i64,
    #[serde(flatten)]
    pub reply: RenderedReply,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> ConversationSettings {
        ConversationSettings::defaults(ConversationId(uuid::Uuid::from_u128(7)))
    }
    fn update() -> ConversationSettingsUpdate {
        ConversationSettingsUpdate {
            expected_revision: 0,
            provider: ConversationProvider::Claude,
            model: Some("claude-opus-4.1".into()),
            reasoning_effort: Some("high".into()),
            honor_no_reply: true,
            reply_prefix: Some("orkestr:".into()),
            reply_footer: Some("-- sent by Orkestr\nreply STOP".into()),
            review_before_accepting: false,
            deep_grouping: None,
            parallel_deep: None,
        }
    }

    #[test]
    fn no_reply_matches_v1_exact_trimmed_whole_message() {
        let s = settings();
        for text in ["NO_REPLY", "  NO_REPLY\n", "\tNO_REPLY "] {
            assert_eq!(
                s.render_reply(text),
                RenderedReply::Suppressed {
                    reason: SuppressedReason::NoReply
                }
            );
        }
        for text in ["no_reply", "NO_REPLY.", "NO_REPLY please", "NO REPLY"] {
            assert!(matches!(
                s.render_reply(text),
                RenderedReply::Deliver { .. }
            ));
        }
        let mut visible = settings();
        visible.honor_no_reply = false;
        assert_eq!(
            visible.render_reply(" NO_REPLY"),
            RenderedReply::Deliver {
                text: " NO_REPLY".into()
            }
        );
        assert_eq!(
            s.render_reply(" \n"),
            RenderedReply::Suppressed {
                reason: SuppressedReason::Empty
            }
        );
    }

    #[test]
    fn prefix_is_not_duplicated_and_footer_is_appended() {
        let mut s = settings();
        s.reply_prefix = Some("orkestr:".into());
        s.reply_footer = Some("-- footer".into());
        fn deliver(s: &ConversationSettings, text: &str) -> String {
            match s.render_reply(text) {
                RenderedReply::Deliver { text } => text,
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(deliver(&s, "hello"), "orkestr: hello\n\n-- footer");
        assert_eq!(deliver(&s, "Orkestr: hi"), "Orkestr: hi\n\n-- footer");
        assert_eq!(deliver(&s, "ö"), "orkestr: ö\n\n-- footer");
        s.reply_footer = None;
        assert_eq!(deliver(&s, "orkestr:x"), "orkestr:x");
    }

    #[test]
    fn codex_overrides_only_for_codex() {
        let mut s = settings();
        s.model = Some("gpt-5.1-codex".into());
        s.reasoning_effort = Some("high".into());
        assert_eq!(
            s.launch().codex_overrides(),
            Some((Some("gpt-5.1-codex"), Some("high")))
        );
        s.provider = ConversationProvider::Claude;
        assert_eq!(s.launch().codex_overrides(), None);
        assert!(s.launch().requires_switch_from(ConversationProvider::Codex));
        assert_eq!(settings().launch().codex_overrides(), Some((None, None)));
    }

    #[test]
    fn updates_are_validated_per_provider() {
        assert!(update().is_valid());
        let mut u = update();
        u.reasoning_effort = Some("xhigh".into());
        assert!(!u.is_valid(), "claude has no xhigh");
        u.provider = ConversationProvider::Codex;
        assert!(u.is_valid());
        for model in ["", "123", "openai", "/abs/path", "a b", &"m".repeat(121)] {
            let mut u = update();
            u.model = Some(model.into());
            assert!(!u.is_valid(), "{model}");
        }
        let mut u = update();
        u.reply_prefix = Some("a\nb".into());
        assert!(!u.is_valid());
        u.reply_prefix = Some(" ".into());
        assert!(!u.is_valid());
        u.reply_prefix = None;
        u.reply_footer = Some("x".repeat(SETTINGS_FOOTER_MAX + 1));
        assert!(!u.is_valid());
        u.reply_footer = Some("bad\u{7}".into());
        assert!(!u.is_valid());
        u.reply_footer = None;
        u.expected_revision = -1;
        assert!(!u.is_valid());
        assert!(
            serde_json::from_value::<ConversationSettingsUpdate>(serde_json::json!({
                "expected_revision": 0, "provider": "gemini", "honor_no_reply": true
            }))
            .is_err()
        );
    }
}
