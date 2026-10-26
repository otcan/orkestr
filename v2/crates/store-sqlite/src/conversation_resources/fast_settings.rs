//! Owner-scoped Fast preferences, consumed at the next dispatch boundary.
use super::{now_ms, settings, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};

async fn current(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<FastRoleSettings> {
    let row=sqlx::query("SELECT revision,model,reasoning_effort,updated_at_ms FROM conversation_fast_settings WHERE conversation_id=?")
        .bind(conversation.to_string()).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    Ok(match row {
        None => FastRoleSettings::defaults(conversation.clone()),
        Some(row) => FastRoleSettings {
            schema_version: 1,
            conversation_id: conversation.clone(),
            revision: row.get("revision"),
            model: row.get("model"),
            reasoning_effort: row.get("reasoning_effort"),
            updated_at_ms: Some(row.get("updated_at_ms")),
        },
    })
}

/// Codex Fast model and effort when the owner selected none. Fast is a quick
/// read-only reply: it must never inherit the native's global default (a
/// Deep-class model at high effort from the operator's Codex config).
pub const FAST_DEFAULT_MODEL: &str = "gpt-6-luna";
pub const FAST_DEFAULT_EFFORT: &str = "low";

/// Historical schemas keep the native launch. Every other Codex Fast turn
/// carries an explicit model and effort: the owner's choice, else the Fast
/// defaults for whichever value is unset. Claude Fast never receives Codex
/// model overrides.
pub(crate) async fn turn_launch(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<Option<TurnLaunch>> {
    let present:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='conversation_fast_settings'")
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    if present == 0 {
        return Ok(None);
    }
    let fast = current(tx, conversation).await?;
    let deep = settings::current(tx, conversation).await?;
    if deep.provider != ConversationProvider::Codex {
        return Ok(None);
    }
    if fast.model.as_deref().is_some_and(model_denied) {
        return Err(ResourceError::Invalid);
    }
    Ok(Some(TurnLaunch {
        settings_revision: fast.revision,
        provider: ConversationProvider::Codex,
        provider_generation: deep.provider_generation,
        model: Some(fast.model.unwrap_or_else(|| FAST_DEFAULT_MODEL.to_owned())),
        reasoning_effort: Some(
            fast.reasoning_effort
                .unwrap_or_else(|| FAST_DEFAULT_EFFORT.to_owned()),
        ),
    }))
}

impl Store {
    /// The explicit Codex model the next Fast turn will request, exactly as
    /// its dispatch computes it. A fresh Fast thread may start with it so the
    /// native start reply reports the model; None keeps the native default.
    pub async fn fast_launch_model(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<String>> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let launch = turn_launch(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(launch.and_then(|launch| launch.model))
    }

    pub async fn fast_role_settings(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<FastRoleSettings> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let value = current(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Full replacement with a separate optimistic revision. Repeating the
    /// same request at the preceding revision is idempotent.
    pub async fn update_fast_role_settings(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        update: &FastRoleSettingsUpdate,
    ) -> Result<FastRoleSettings> {
        if !update.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let deep = settings::current(&mut tx, conversation).await?;
        if deep.provider != ConversationProvider::Codex {
            return Err(ResourceError::Conflict("fast_codex_settings_require_codex"));
        }
        let before = current(&mut tx, conversation).await?;
        if before.revision != update.expected_revision {
            if before.revision == update.expected_revision + 1
                && before.model == update.model
                && before.reasoning_effort == update.reasoning_effort
            {
                tx.commit().await.map_err(unavailable)?;
                return Ok(before);
            }
            return Err(ResourceError::Conflict("fast_settings_revision_mismatch"));
        }
        sqlx::query("INSERT INTO conversation_fast_settings(conversation_id,owner_id,revision,model,reasoning_effort,updated_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,model=excluded.model,reasoning_effort=excluded.reasoning_effort,updated_at_ms=excluded.updated_at_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(before.revision+1).bind(&update.model).bind(&update.reasoning_effort).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let value = current(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }
}
