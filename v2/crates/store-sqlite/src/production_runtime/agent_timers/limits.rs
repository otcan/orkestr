//! Owner side: the rolling 24-hour create cap of one conversation's agent
//! timers (migration 0085). No row: the server default (24 unless
//! `ORKESTR_V2_AGENT_TIMER_DAILY_CREATES_MAX` says otherwise). The owner marks
//! a chat that only they are in `owner_only` (server default 200), sets a
//! `fixed` number, or turns the daily cap `off`. The hourly create cap, the
//! live timer cap and the schedule caps are not configurable.
use super::*;
use orkestr_v2_contracts::{
    AgentTimerCapMode, AgentTimerDailyCaps, AgentTimerLimits, AgentTimerLimitsUpdate,
};

async fn setting(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> R<(AgentTimerCapMode, Option<i64>)> {
    let row: Option<(String, Option<i64>)> = sqlx::query_as(
        "SELECT mode,daily_creates_max FROM agent_timer_limits WHERE owner_id=? AND conversation_id=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .fetch_optional(tx)
    .await
    .map_err(unavailable)?;
    match row {
        None => Ok((AgentTimerCapMode::Default, None)),
        Some((mode, max)) => Ok((
            AgentTimerCapMode::parse(&mode).ok_or(ResourceError::Unavailable)?,
            max,
        )),
    }
}

/// The effective daily create cap of the conversation (`None` = no cap).
pub(crate) async fn daily_cap(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    defaults: AgentTimerDailyCaps,
) -> R<Option<i64>> {
    let (mode, max) = setting(tx, owner, conversation).await?;
    Ok(defaults.resolve(mode, max))
}

impl Store {
    async fn limits_in(
        &self,
        tx: &mut SqliteConnection,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerLimits> {
        let (mode, max) = setting(tx, owner, conversation).await?;
        let since = now_ms() - 86_400_000;
        let created: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent_timers WHERE owner_id=? AND conversation_id=? AND created_ms>?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(since)
        .fetch_one(tx)
        .await
        .map_err(unavailable)?;
        Ok(AgentTimerLimits {
            conversation_id: conversation.clone(),
            mode,
            daily_creates_max: self.agent_timer_daily.resolve(mode, max),
            hourly_creates_max: AGENT_TIMER_HOURLY_CREATES_MAX,
            live_timers_max: AGENT_TIMER_ACTIVE_MAX,
            created_last_24h: created,
        })
    }

    /// The conversation's agent timer create caps as they apply now.
    pub async fn agent_timer_limits(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerLimits> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let value = self.limits_in(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Set the conversation's daily create cap (`default` removes the setting).
    /// Never touches timer history: earlier creates still count in the window.
    pub async fn set_agent_timer_limits(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        update: &AgentTimerLimitsUpdate,
    ) -> R<AgentTimerLimits> {
        if !update.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        if update.mode == AgentTimerCapMode::Default {
            sqlx::query("DELETE FROM agent_timer_limits WHERE owner_id=? AND conversation_id=?")
                .bind(owner.to_string())
                .bind(conversation.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        } else {
            sqlx::query("INSERT INTO agent_timer_limits(conversation_id,owner_id,mode,daily_creates_max,updated_ms) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET mode=excluded.mode,daily_creates_max=excluded.daily_creates_max,updated_ms=excluded.updated_ms")
                .bind(conversation.to_string()).bind(owner.to_string()).bind(update.mode.text())
                .bind(update.daily_creates_max).bind(now_ms())
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        let value = self.limits_in(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Mark a conversation owner-only unless the owner already chose a cap
    /// (used when a new owner-only WhatsApp chat gets its timer grant).
    pub async fn default_agent_timer_limits_owner_only(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerLimits> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        sqlx::query("INSERT INTO agent_timer_limits(conversation_id,owner_id,mode,daily_creates_max,updated_ms) VALUES(?,?,'owner_only',NULL,?) ON CONFLICT(conversation_id) DO NOTHING")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let value = self.limits_in(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }
}
