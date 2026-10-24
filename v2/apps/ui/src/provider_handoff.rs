//! Explicit UI intent; no execution or old-input replay is implied by a form.
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettings, ExecutionWindowState, ExecutionWindowStatus,
    ProviderHandoffRequest,
};

#[derive(Clone, PartialEq)]
pub struct HandoffForm {
    pub provider: ConversationProvider,
    pub model: String,
    pub effort: String,
    pub history: String,
    pub acknowledged: bool,
}

impl HandoffForm {
    pub fn for_settings(settings: &ConversationSettings) -> Self {
        let provider = match settings.provider {
            ConversationProvider::Claude => ConversationProvider::Codex,
            ConversationProvider::Codex => ConversationProvider::Claude,
        };
        let mut form = Self {
            provider,
            model: String::new(),
            effort: "high".into(),
            history: String::new(),
            acknowledged: false,
        };
        form.select(provider);
        form
    }
    pub fn select(&mut self, provider: ConversationProvider) {
        self.provider = provider;
        self.model = match provider {
            ConversationProvider::Codex => "gpt-6.1-sol",
            ConversationProvider::Claude => "opus",
        }
        .into();
        if !provider.efforts().contains(&self.effort.as_str()) {
            self.effort = "high".into();
        }
    }
    pub fn request(
        &self,
        key: String,
        settings: &ConversationSettings,
        window: &ExecutionWindowStatus,
    ) -> Result<ProviderHandoffRequest, &'static str> {
        if window.conversation_id != settings.conversation_id
            || window.state != ExecutionWindowState::Closed
            || self.provider == settings.provider
        {
            return Err("Choose another provider after the current work window has closed.");
        }
        let request = ProviderHandoffRequest {
            request_key: key,
            window_id: window.window_id,
            generation: window.generation,
            expected_settings_revision: settings.revision,
            target_provider: self.provider,
            model: Some(self.model.trim().into()),
            reasoning_effort: Some(self.effort.clone()),
            acknowledge_new_native_session: self.acknowledged,
            history_summary: self.history.clone(),
        };
        if !request.is_valid() {
            return Err("Choose an allowed model, review a 1–16384 byte history summary, and confirm the new session.");
        }
        Ok(request)
    }
}
