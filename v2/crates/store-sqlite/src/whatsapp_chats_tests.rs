use super::*;
use crate::conversation_resources::tests_settings::Case;

fn identity(conversation: &ConversationId, key: &str) -> WhatsAppChatIdentity {
    WhatsAppChatIdentity {
        request_key: key.into(),
        conversation_id: conversation.clone(),
        name: "Synthetic chat".into(),
        v1_thread_id: format!("v1-{key}"),
        remote_thread_id: key.into(),
        workspace: Some("/srv/synthetic".into()),
    }
}
const KEY_1: &str = "00000000-0000-4000-8000-000000000001";
const KEY_2: &str = "00000000-0000-4000-8000-000000000002";

#[tokio::test]
async fn provisions_are_idempotent_forward_only_and_retained() {
    let case = Case::new().await;
    let chat = case.conversation("synthetic-chat").await;
    let first = case
        .store
        .begin_whatsapp_chat(&case.token, &case.owner, &identity(&chat, KEY_1))
        .await
        .unwrap();
    assert_eq!(first.stage, WhatsAppChatStage::Conversation);
    // The same key returns the same row; a different identity is refused.
    let again = case
        .store
        .begin_whatsapp_chat(&case.token, &case.owner, &identity(&chat, KEY_1))
        .await
        .unwrap();
    assert_eq!(again, first);
    // A retry keeps the first request's V1 thread and route ids.
    let mut retry = identity(&chat, KEY_1);
    retry.v1_thread_id = "v1-other".into();
    retry.remote_thread_id = KEY_2.into();
    let retried = case
        .store
        .begin_whatsapp_chat(&case.token, &case.owner, &retry)
        .await
        .unwrap();
    assert_eq!(retried.v1_thread_id, first.v1_thread_id);
    let mut renamed = identity(&chat, KEY_1);
    renamed.name = "Other".into();
    assert_eq!(
        case.store
            .begin_whatsapp_chat(&case.token, &case.owner, &renamed)
            .await,
        Err(ResourceError::Conflict("whatsapp_chat_conflict"))
    );
    // One provision per conversation.
    assert_eq!(
        case.store
            .begin_whatsapp_chat(&case.token, &case.owner, &identity(&chat, KEY_2))
            .await,
        Err(ResourceError::Conflict("whatsapp_chat_conflict"))
    );
    let advance = |stage, chat_id: Option<&'static str>, error: Option<&'static str>| {
        let store = case.store.clone();
        let (token, owner) = (case.token.clone(), case.owner.clone());
        async move {
            store
                .advance_whatsapp_chat(&token, &owner, KEY_1, stage, chat_id, error)
                .await
        }
    };
    // The group stage needs its chat.
    assert_eq!(
        advance(WhatsAppChatStage::Group, None, None).await,
        Err(ResourceError::Invalid)
    );
    let failed = advance(WhatsAppChatStage::V1Thread, None, Some("v1_group_failed"))
        .await
        .unwrap();
    assert_eq!(
        (failed.stage, failed.error.as_deref()),
        (WhatsAppChatStage::V1Thread, Some("v1_group_failed"))
    );
    let group = advance(WhatsAppChatStage::Group, Some("000@g.us"), None)
        .await
        .unwrap();
    assert_eq!(
        (group.chat_id.as_deref(), group.error),
        (Some("000@g.us"), None)
    );
    // Never backwards, and the group is fixed.
    let back = advance(WhatsAppChatStage::Settings, None, None)
        .await
        .unwrap();
    assert_eq!(back.stage, WhatsAppChatStage::Group);
    assert_eq!(
        advance(WhatsAppChatStage::Ready, Some("001@g.us"), None).await,
        Err(ResourceError::Conflict("whatsapp_chat_group_changed"))
    );
    let archived = case
        .store
        .archive_whatsapp_chat(&case.token, &case.owner, KEY_1)
        .await
        .unwrap();
    assert!(archived.archived);
    assert!(sqlx::query("DELETE FROM whatsapp_chat_provisions")
        .execute(&case.store.pool)
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE whatsapp_chat_provisions SET v1_thread_id='other'")
            .execute(&case.store.pool)
            .await
            .is_err()
    );
    let list = case
        .store
        .whatsapp_chats(&case.token, &case.owner)
        .await
        .unwrap();
    assert_eq!(list.len(), 1);
    // The sidebar links the conversation to its V1 group thread.
    let sidebar = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    let row = sidebar
        .conversations
        .iter()
        .find(|c| c.conversation_id == chat)
        .unwrap();
    assert_eq!(
        row.source_thread_id.as_deref(),
        Some("v1-00000000-0000-4000-8000-000000000001")
    );
    // Other credentials see nothing.
    assert_eq!(
        case.store
            .whatsapp_chats("not-a-session", &case.owner)
            .await,
        Err(ResourceError::Unauthorized)
    );
}
