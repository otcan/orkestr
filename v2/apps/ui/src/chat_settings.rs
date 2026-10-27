//! Owner settings of a native conversation (V1 thread-settings parity):
//! provider, model, effort, NO_REPLY handling, reply prefix/footer and
//! whether replies wait for review before acceptance. The
//! form is a full replacement guarded by the revision it was read at.
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettings, ConversationSettingsUpdate,
};

#[derive(Clone, Default, PartialEq)]
pub struct SettingsForm {
    pub revision: i64,
    pub provider: ConversationProvider,
    pub model: String,
    pub effort: String,
    pub honor_no_reply: bool,
    pub reply_prefix: String,
    pub reply_footer: String,
    /// Off (default): owner turns are accepted automatically, like V1.
    pub review_before_accepting: bool,
    /// Off (default): one Deep turn at a time. On: read-only parallel Deep
    /// turns may answer queued messages (docs/v2/parallel-deep.md).
    pub parallel_deep: bool,
    /// The value read with `revision`; an update sends the switch only
    /// when the owner changed it.
    pub parallel_deep_loaded: bool,
}

fn optional(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

impl SettingsForm {
    pub fn from_settings(value: &ConversationSettings) -> Self {
        Self {
            revision: value.revision,
            provider: value.provider,
            model: value.model.clone().unwrap_or_default(),
            effort: value.reasoning_effort.clone().unwrap_or_default(),
            honor_no_reply: value.honor_no_reply,
            reply_prefix: value.reply_prefix.clone().unwrap_or_default(),
            reply_footer: value.reply_footer.clone().unwrap_or_default(),
            review_before_accepting: value.review_before_accepting,
            parallel_deep: value.parallel_deep,
            parallel_deep_loaded: value.parallel_deep,
        }
    }
    /// Switching provider keeps the effort only when the new provider has it.
    pub fn set_provider(&mut self, provider: ConversationProvider) {
        self.provider = provider;
        if !provider.efforts().contains(&self.effort.as_str()) {
            self.effort.clear();
        }
    }
    pub fn update(&self) -> Result<ConversationSettingsUpdate, &'static str> {
        let update = ConversationSettingsUpdate {
            expected_revision: self.revision,
            provider: self.provider,
            model: optional(&self.model),
            reasoning_effort: optional(&self.effort),
            honor_no_reply: self.honor_no_reply,
            reply_prefix: optional(&self.reply_prefix),
            reply_footer: optional(&self.reply_footer),
            review_before_accepting: self.review_before_accepting,
            deep_grouping: None,
            parallel_deep: (self.parallel_deep != self.parallel_deep_loaded)
                .then_some(self.parallel_deep),
        };
        if update.is_valid() {
            Ok(update)
        } else {
            Err("Check the model name, the effort for this provider, and the prefix (64) and footer (512) lengths.")
        }
    }
}

/// Desktop slugs typed as a comma or space separated list.
pub fn slugs(value: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for slug in value
        .split([',', ' ', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !out.iter().any(|s| s == slug) {
            out.push(slug.to_owned());
        }
    }
    out
}

/// Whether this conversation's replies are accepted automatically (the
/// default). Unknown settings keep the manual Accept prompt.
pub fn auto_accepts(settings: Option<&ConversationSettings>) -> bool {
    settings.is_some_and(|s| !s.review_before_accepting)
}
