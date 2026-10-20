//! Window provider from the conversation's owner settings (B3). The setting
//! selects a configured runtime, never an account, credential or executable.
use super::*;
use orkestr_v2_contracts::TurnLaunch;

impl Store {
    /// Unbound read for the trusted window controller and Claude launches:
    /// the settings a turn started now would use (owner-scoped).
    pub async fn conversation_turn_launch(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<TurnLaunch> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        let launch = crate::conversation_resources::settings::turn_launch(&mut tx, conversation)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        tx.commit().await.map_err(db)?;
        Ok(launch)
    }

    /// Native provider of the conversation's committed Deep identity, if any.
    /// A window may only continue that identity; switching providers between
    /// windows needs the separate handoff path.
    pub async fn conversation_native_provider(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<ProviderKind>> {
        let value: Option<String> = sqlx::query_scalar("SELECT provider_kind FROM session_bindings WHERE owner_id=? AND conversation_id=? AND role='deep' AND state!='retired' AND provider_kind!='unconfigured'")
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?;
        Ok(match value.as_deref() {
            None => None,
            Some("codex") => Some(ProviderKind::Codex),
            Some("claude") => Some(ProviderKind::Claude),
            Some(_) => return Err(RuntimeStoreError::Unavailable),
        })
    }
}

/// Window composition supports the two native providers only.
pub(in crate::production_runtime) fn window_provider(provider: ProviderKind) -> bool {
    matches!(provider, ProviderKind::Codex | ProviderKind::Claude)
}
