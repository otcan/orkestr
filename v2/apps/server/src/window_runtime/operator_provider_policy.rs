//! Standing operator handoff under the controller admission lock. The current
//! canonical input stays queued; prior input/run identities are never replayed.
use super::*;
use orkestr_v2_contracts::{ConversationProvider, ProviderHandoffRequest};
impl Controller {
    pub(in crate::window_runtime) async fn route_operator_policy(
        &self,
        browser: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<Option<ExecutionWindowRequest>, &'static str> {
        let Some(policy) = &self.config.provider_routing else {
            return Ok(Some(input.clone()));
        };
        let text = self
            .store
            .conversation_routing_input(browser, owner, conversation, &input.input_message_id)
            .await
            .map_err(|_| "provider policy input unavailable")?;
        let settings = self
            .store
            .conversation_settings(browser, owner, conversation)
            .await
            .map_err(|_| "provider policy settings unavailable")?;
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
        if rules.is_empty() {
            return Ok(Some(input.clone()));
        }
        let proof = crate::provider_policy::proof(policy, input.input_message_id.clone(), rules)?;
        self.store
            .remember_provider_policy_authenticated(browser, owner, conversation, &proof)
            .await
            .map_err(|_| "provider policy scope recording refused")?;
        if target == selected {
            return Ok(Some(input.clone()));
        }
        let Some(mut window) = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await
            .map_err(|_| "provider policy predecessor unavailable")?
        else {
            return Ok(Some(input.clone()));
        };
        if !policy.allow_native_handoff {
            return Err("provider routing requires an explicit provider handoff");
        }
        if target == ConversationProvider::Claude && self.config.claude.is_none() {
            return Err("provider routing target is not configured");
        }
        if proof.source_commit == "unknown" {
            return Err("provider policy handoff requires qualified source");
        }
        // Reuse ordinary idle retirement, including all original native reap
        // witnesses. The new triggering message has not joined the old window.
        if window.state != ExecutionWindowState::Closed {
            if let Some(entry) = self.existing(conversation) {
                if entry.retire_if_idle(browser).await.unwrap_or(false) {
                    window = self
                        .store
                        .execution_window_status_authenticated(browser, conversation)
                        .await
                        .map_err(|_| "provider policy predecessor unavailable")?
                        .ok_or("provider policy predecessor missing")?;
                }
            }
        }
        if self.live_owner(conversation).await
            || window.state != ExecutionWindowState::Closed
            || !self.manager_released(&window, true).await
        {
            return Ok(None);
        }
        let summary = self
            .store
            .provider_policy_history(owner, conversation, &input.input_message_id)
            .await
            .map_err(|_| "provider policy history unavailable")?;
        let request = ProviderHandoffRequest {
            request_key: format!(
                "policy:{}:{}",
                &proof.policy_sha256[..16],
                input.input_message_id
            ),
            window_id: window.window_id,
            generation: window.generation,
            expected_settings_revision: settings.revision,
            target_provider: target,
            model: None,
            reasoning_effort: None,
            acknowledge_new_native_session: true,
            history_summary: summary,
        };
        // Preserve the caller's ORIGINAL intent/digest before changing its
        // window tuple. Durable queue dispatch reconstructs the new tuple;
        // retries (including a lost handoff reply) can only observe this row.
        self.store
            .enqueue_execution_window_authenticated(browser, conversation, input)
            .await
            .map_err(|_| "provider policy original intent preservation refused")?;
        self.store
            .handoff_provider_for_operator_policy(browser, conversation, &request, &proof)
            .await
            .map_err(|_| "provider policy handoff refused")?;
        self.forget(conversation)?;
        self.queue.remember(browser);
        self.queue.wake();
        Ok(None)
    }
}

impl Controller {
    pub(crate) async fn queue_policy_steering(
        &self,
        browser: &str,
        owner: &OwnerId,
        receipt: &orkestr_v2_contracts::ExecutionSteeringReceipt,
    ) -> Result<(), &'static str> {
        let request = self
            .store
            .policy_steering_window_request(browser, owner, receipt)
            .await
            .map_err(|_| "provider policy steering input unavailable")?;
        self.enqueue(browser, &receipt.conversation_id, &request)
            .await?;
        Ok(())
    }
}

impl Controller {
    pub(in crate::window_runtime) async fn recover_policy_steering(
        &self,
        browser: &str,
    ) -> Result<(), orkestr_v2_application::runtime::RuntimeStoreError> {
        let Some(policy) = &self.config.provider_routing else {
            return Ok(());
        };
        if !policy.allow_native_handoff {
            return Ok(());
        }
        let owner = &self.config.owner_id;
        for receipt in self
            .store
            .pending_policy_steering_authenticated(browser, owner)
            .await?
        {
            let conversation = &receipt.conversation_id;
            let text = self
                .store
                .conversation_routing_input(browser, owner, conversation, &receipt.message_id)
                .await?;
            let settings = self
                .store
                .conversation_settings(browser, owner, conversation)
                .await
                .map_err(|_| orkestr_v2_application::runtime::RuntimeStoreError::Unavailable)?;
            let (target, rules) = crate::provider_policy::select(
                &self.store,
                policy,
                owner,
                conversation,
                &text,
                settings.provider,
            )
            .await
            .map_err(|_| orkestr_v2_application::runtime::RuntimeStoreError::Unavailable)?;
            if target == settings.provider || rules.is_empty() {
                continue;
            }
            let proof = crate::provider_policy::proof(policy, receipt.message_id.clone(), rules)
                .map_err(|_| orkestr_v2_application::runtime::RuntimeStoreError::Unavailable)?;
            self.store
                .remember_provider_policy_authenticated(browser, owner, conversation, &proof)
                .await?;
            // Admission still repeats current input, held/consumed, settings,
            // window generation and original steering receipt predicates.
            let _ = self.queue_policy_steering(browser, owner, &receipt).await;
        }
        Ok(())
    }
}
