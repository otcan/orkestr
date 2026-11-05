//! Originating-source decisions use ordinary durable window dispatch. Admission
//! and intent commit together; dispatch never chooses a replacement identity.
use super::*;
use sqlx::SqliteConnection;

pub(super) async fn enqueue(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    input: &MessageInput,
    receipt: &Receipt,
) -> Result<()> {
    let restricted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM restricted_threads WHERE conversation_id=? AND enabled=1",
    )
    .bind(conversation.to_string())
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if restricted != 0 {
        return Err(StoreError::Conflict);
    }
    crate::production_runtime::enqueue_trusted_intent(
        tx,
        owner,
        conversation,
        receipt.message_id.clone(),
        receipt.event_id.clone(),
        &input.client_message_id,
        format!("source-continuation:{}", receipt.event_id.0),
    )
    .await
    .map_err(|error| {
        use orkestr_v2_application::runtime::RuntimeStoreError as E;
        match error {
            E::InvalidInput => StoreError::Invalid,
            E::Conflict | E::Fenced => StoreError::Conflict,
            _ => StoreError::Unavailable,
        }
    })
}

/// Repeat the original transaction's fences at dispatch, not just at POST time.
/// Ordinary messages (including legacy duplicates without evidence) do not
/// acquire a source identity here.
pub(crate) async fn validate(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    message: &MessageId,
) -> Result<()> {
    let row = sqlx::query("SELECT f.source_run_id,f.expected_provider_generation,f.source_native_session_id,f.source_provider,f.source_binding_generation,r.native_session_id,r.provider_kind,r.binding_generation,COALESCE(s.provider_generation,0) AS current_provider_generation FROM source_admission_fences f JOIN messages m ON m.id=f.message_id JOIN production_runs r ON r.id=f.source_run_id AND r.owner_id=m.owner_id AND r.conversation_id=m.conversation_id LEFT JOIN conversation_settings s ON s.owner_id=m.owner_id AND s.conversation_id=m.conversation_id WHERE m.id=? AND m.owner_id=? AND m.conversation_id=?")
        .bind(message.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(row) = row else {
        return Ok(());
    };
    let run = RunId(parse(row.get("source_run_id"))?);
    if row.get::<i64, _>("expected_provider_generation")
        != row.get::<i64, _>("current_provider_generation")
        || row.get::<String, _>("source_native_session_id")
            != row.get::<String, _>("native_session_id")
        || row.get::<String, _>("source_provider") != row.get::<String, _>("provider_kind")
        || row.get::<i64, _>("source_binding_generation") != row.get::<i64, _>("binding_generation")
        || !crate::source_context::source_binding_is_current(tx, owner, conversation, &run).await?
    {
        return Err(StoreError::ProviderGenerationMismatch);
    }
    Ok(())
}
