//! Refuse before claiming/consuming input or creating the wrong native process.
use super::*;
use orkestr_v2_contracts::{ConversationProvider, MessageId};
impl ConfiguredExecution {
    pub(super) async fn provider_input_refusal(
        &self,
        message: &MessageId,
    ) -> Result<Option<orkestr_v2_store_sqlite::OperatorProviderPolicy>, &'static str> {
        let Some(policy) = &self.config.provider_routing else {
            return Ok(None);
        };
        let text = self
            .store
            .provider_policy_input(&self.owner, &self.config.conversation_id, message)
            .await
            .map_err(|_| "provider policy input unavailable")?;
        let selected = match self.config.provider {
            config::Provider::Codex => ConversationProvider::Codex,
            config::Provider::Claude => ConversationProvider::Claude,
        };
        let (target, rules) = crate::provider_policy::select(
            &self.store,
            policy,
            &self.owner,
            &self.config.conversation_id,
            &text,
            selected,
        )
        .await?;
        if target == selected {
            return Ok(None);
        }
        crate::provider_policy::proof(policy, message.clone(), rules).map(Some)
    }
    pub(super) async fn provider_input_allowed(
        &self,
        message: Option<&MessageId>,
    ) -> Result<bool, &'static str> {
        let Some(policy) = &self.config.provider_routing else {
            return Ok(true);
        };
        let text = if let Some(message) = message {
            self.store
                .provider_policy_input(&self.owner, &self.config.conversation_id, message)
                .await
                .map_err(|_| "provider policy input unavailable")?
        } else {
            let Some((_, text)) = self
                .store
                .prospective_provider_input(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "provider policy prospective input unavailable")?
            else {
                return Ok(true);
            };
            text
        };
        let selected = match self.config.provider {
            config::Provider::Codex => ConversationProvider::Codex,
            config::Provider::Claude => ConversationProvider::Claude,
        };
        let (target, _) = crate::provider_policy::select(
            &self.store,
            policy,
            &self.owner,
            &self.config.conversation_id,
            &text,
            selected,
        )
        .await?;
        Ok(target == selected)
    }
}
