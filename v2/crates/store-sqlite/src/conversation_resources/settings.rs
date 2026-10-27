//! Owner conversation settings with optimistic revision control.
use super::{now_ms, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};

pub(crate) async fn current(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<ConversationSettings> {
    let row = sqlx::query("SELECT * FROM conversation_settings WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?;
    let Some(row) = row else {
        return Ok(ConversationSettings::defaults(conversation.clone()));
    };
    Ok(ConversationSettings {
        schema_version: 1,
        conversation_id: conversation.clone(),
        revision: row.get("revision"),
        provider: ConversationProvider::parse(row.get::<String, _>("provider").as_str())
            .ok_or(ResourceError::Unavailable)?,
        model: row.get("model"),
        reasoning_effort: row.get("reasoning_effort"),
        honor_no_reply: row.get::<i64, _>("honor_no_reply") == 1,
        reply_prefix: row.get("reply_prefix"),
        reply_footer: row.get("reply_footer"),
        provider_generation: row.get("provider_generation"),
        updated_at_ms: Some(row.get("updated_at_ms")),
        // Absent only on a test store downgraded below 0060: the default.
        review_before_accepting: row
            .try_get::<i64, _>("review_before_accepting")
            .is_ok_and(|value| value == 1),
        // Absent only on a test store downgraded below 0082: default on.
        deep_grouping: row
            .try_get::<i64, _>("deep_grouping")
            .map_or(true, |value| value != 0),
    })
}

/// Whether the next Deep admission of `conversation` may group a burst of
/// queued owner inputs. Read inside the admission transaction (live, no
/// cache). A historical test store below 0082 never groups.
pub(crate) async fn deep_grouping(
    conn: &mut sqlx::SqliteConnection,
    conversation: &str,
) -> std::result::Result<bool, sqlx::Error> {
    let present: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_table_info('conversation_settings') WHERE name='deep_grouping'",
    )
    .fetch_one(&mut *conn)
    .await?;
    if present == 0 {
        return Ok(false);
    }
    let value: Option<i64> = sqlx::query_scalar(
        "SELECT deep_grouping FROM conversation_settings WHERE conversation_id=?",
    )
    .bind(conversation)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(value.is_none_or(|value| value != 0))
}

/// Launch parameters for the next Deep/Worker turn of `conversation`, read
/// inside the caller's dispatch transaction. Absent settings mean defaults.
pub(crate) async fn turn_launch(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<TurnLaunch> {
    // A store still on a pre-0050 schema (historical upgrade paths) has no
    // settings table yet: it can only have defaults.
    let present: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='conversation_settings'",
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(unavailable)?;
    if present == 0 {
        return Ok(ConversationSettings::defaults(conversation.clone()).launch());
    }
    let settings = current(tx, conversation).await?;
    if settings
        .model
        .as_deref()
        .is_some_and(orkestr_v2_contracts::model_denied)
    {
        return Err(ResourceError::Invalid);
    }
    Ok(settings.launch())
}

impl Store {
    pub async fn conversation_settings(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<ConversationSettings> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let settings = current(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(settings)
    }

    /// Full replacement. A provider change bumps `provider_generation` so the
    /// runtime switches at the next turn boundary (V1 `orkestr switch`).
    /// Replaying an identical update at the previous revision is idempotent.
    pub async fn update_conversation_settings(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        update: &ConversationSettingsUpdate,
    ) -> Result<ConversationSettings> {
        if !update.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let before = current(&mut tx, conversation).await?;
        if before.provider != update.provider {
            let history: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM execution_windows WHERE conversation_id=?) + (SELECT count(*) FROM session_bindings WHERE conversation_id=? AND native_session_id IS NOT NULL)")
                .bind(conversation.to_string()).bind(conversation.to_string())
                .fetch_one(&mut *tx).await.map_err(unavailable)?;
            if history != 0 {
                return Err(ResourceError::Conflict("provider_handoff_required"));
            }
        }
        let same = |s: &ConversationSettings| {
            s.provider == update.provider
                && s.model == update.model
                && s.reasoning_effort == update.reasoning_effort
                && s.honor_no_reply == update.honor_no_reply
                && s.reply_prefix == update.reply_prefix
                && s.reply_footer == update.reply_footer
                && s.review_before_accepting == update.review_before_accepting
                && update
                    .deep_grouping
                    .is_none_or(|grouping| grouping == s.deep_grouping)
        };
        if before.revision != update.expected_revision {
            if before.revision == update.expected_revision + 1 && same(&before) {
                tx.commit().await.map_err(unavailable)?;
                return Ok(before);
            }
            return Err(ResourceError::Conflict("settings_revision_mismatch"));
        }
        let generation = before.provider_generation + i64::from(before.provider != update.provider);
        sqlx::query(
            "INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,model,reasoning_effort,honor_no_reply,reply_prefix,reply_footer,provider_generation,updated_at_ms,review_before_accepting)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,provider=excluded.provider,model=excluded.model,
             reasoning_effort=excluded.reasoning_effort,honor_no_reply=excluded.honor_no_reply,reply_prefix=excluded.reply_prefix,
             reply_footer=excluded.reply_footer,provider_generation=excluded.provider_generation,updated_at_ms=excluded.updated_at_ms,
             review_before_accepting=excluded.review_before_accepting",
        )
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .bind(before.revision + 1)
        .bind(update.provider.as_str())
        .bind(&update.model)
        .bind(&update.reasoning_effort)
        .bind(i64::from(update.honor_no_reply))
        .bind(&update.reply_prefix)
        .bind(&update.reply_footer)
        .bind(generation)
        .bind(now_ms())
        .bind(i64::from(update.review_before_accepting))
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        // The upsert leaves the switch alone: an omitted value keeps the
        // current one (a fresh row has the default, on).
        if let Some(grouping) = update.deep_grouping {
            sqlx::query("UPDATE conversation_settings SET deep_grouping=? WHERE conversation_id=?")
                .bind(i64::from(grouping))
                .bind(conversation.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        let after = current(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(after)
    }
}
