//! "New WhatsApp chat" form state. The request id is kept until the server
//! answers, so a retry continues the same chat (same conversation, V1 thread
//! and group) instead of creating a second one.
use orkestr_v2_contracts::{
    ConversationProvider, WhatsAppChatProvision, WhatsAppChatRequest, WhatsAppChatStage,
};

#[derive(Clone, Default, PartialEq)]
pub struct ChatForm {
    pub name: String,
    pub provider: ConversationProvider,
    pub model: String,
    pub effort: String,
    pub workspace: String,
    /// The request in flight or to retry; edits wait until it finishes.
    pub pending: Option<WhatsAppChatRequest>,
}

fn optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

impl ChatForm {
    pub fn prepare(&mut self, key: String) -> Result<WhatsAppChatRequest, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.clone());
        }
        let request = WhatsAppChatRequest {
            client_request_id: key,
            name: self.name.trim().to_owned(),
            provider: self.provider,
            model: optional(&self.model),
            reasoning_effort: optional(&self.effort),
            workspace: optional(&self.workspace),
        };
        if !request.is_valid() {
            return Err("Check the name (1–100 characters), the model, the effort for this provider and that the workspace is an absolute path.");
        }
        self.pending = Some(request.clone());
        Ok(request)
    }
    /// A definite refusal: keep the fields, a new attempt gets a new id.
    pub fn refused(&mut self) {
        self.pending = None;
    }
    pub fn efforts(&self) -> &'static [&'static str] {
        self.provider.efforts()
    }
}

/// What the owner sees about a provision.
pub fn status(provision: &WhatsAppChatProvision) -> String {
    if let Some(error) = &provision.error {
        return format!(
            "Stopped after “{}”: {error}. Retry continues from there.",
            stage(provision.stage)
        );
    }
    match provision.stage {
        WhatsAppChatStage::Ready => "Ready: the WhatsApp group talks to this chat.".into(),
        WhatsAppChatStage::RelayPending => {
            "WhatsApp group created and connected to this chat. Group messages start once the operator registers the group with the relay.".into()
        }
        other => format!("In progress: {}.", stage(other)),
    }
}

pub fn stage(stage: WhatsAppChatStage) -> &'static str {
    match stage {
        WhatsAppChatStage::Conversation => "conversation created",
        WhatsAppChatStage::Settings => "settings saved",
        WhatsAppChatStage::V1Thread => "V1 thread created",
        WhatsAppChatStage::Group => "WhatsApp group created",
        WhatsAppChatStage::AdapterBinding => "connected to V2",
        WhatsAppChatStage::RelayPending => "delegated to V2",
        WhatsAppChatStage::Ready => "ready",
    }
}
