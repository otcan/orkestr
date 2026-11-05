//! Shared direct/queued/timer window admission policy. Running turns are never
//! silently transplanted to another provider or resumed under another account.
use super::*;
use orkestr_v2_contracts::{ConversationProvider, ConversationSettingsUpdate};

impl ConversationController {
    pub(super) async fn apply_provider_routing(
        &self,
        browser: &str,
        owner: &orkestr_v2_contracts::OwnerId,
        conversation: &orkestr_v2_contracts::ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<(), &'static str> {
        let Some(policy) = &self.config.provider_routing else {
            return Ok(());
        };
        let text = self
            .store
            .conversation_routing_input(browser, owner, conversation, &input.input_message_id)
            .await
            .map_err(|_| "provider routing input unavailable")?;
        let settings = self
            .store
            .conversation_settings(browser, owner, conversation)
            .await
            .map_err(|_| "provider routing settings unavailable")?;
        if settings
            .model
            .as_deref()
            .is_some_and(orkestr_v2_contracts::model_denied)
        {
            return Err("model is denied by server policy");
        }
        let selected = if settings.provider == ConversationProvider::Codex
            && settings.revision == 0
            && self.config.claude.as_ref().is_some_and(|c| c.default)
        {
            ConversationProvider::Claude
        } else {
            settings.provider
        };
        let (target, rules) = crate::provider_policy::select(
            &self.store,
            policy,
            owner,
            conversation,
            &text,
            selected,
        )
        .await?;
        if !rules.is_empty() {
            let proof =
                crate::provider_policy::proof(policy, input.input_message_id.clone(), rules)?;
            self.store
                .remember_provider_policy_authenticated(browser, owner, conversation, &proof)
                .await
                .map_err(|_| "provider policy scope recording refused")?;
        }
        if target == selected {
            return Ok(());
        }
        if target == ConversationProvider::Claude && self.config.claude.is_none() {
            return Err("provider routing target is not configured");
        }
        let native = self
            .store
            .conversation_native_provider(owner, conversation)
            .await
            .map_err(|_| "provider routing native identity unavailable")?;
        if native.is_some() || input.window_id.is_some() {
            return Err("provider routing requires an explicit provider handoff");
        }
        // A fresh conversation can record the operator's route through the
        // existing revision-checked settings transaction. That transaction also
        // rejects a provider change once any execution window exists. This is
        // essential: changing just the launcher would leave turn settings and
        // provider generations pointing at the previous runtime.
        let same_provider = settings.provider == target;
        self.store
            .update_conversation_settings(
                browser,
                owner,
                conversation,
                &ConversationSettingsUpdate {
                    expected_revision: settings.revision,
                    provider: target,
                    model: if same_provider { settings.model } else { None },
                    reasoning_effort: if same_provider {
                        settings.reasoning_effort
                    } else {
                        None
                    },
                    honor_no_reply: settings.honor_no_reply,
                    reply_prefix: settings.reply_prefix,
                    reply_footer: settings.reply_footer,
                    review_before_accepting: settings.review_before_accepting,
                    deep_grouping: Some(settings.deep_grouping),
                    parallel_deep: Some(settings.parallel_deep),
                },
            )
            .await
            .map_err(|_| {
                "provider routing settings update refused; explicit handoff may be required"
            })?;
        eprintln!(
            "provider routing applied: conversation={conversation} from={} to={}",
            selected.as_str(),
            target.as_str()
        );
        Ok(())
    }
}
