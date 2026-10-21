use super::*;
use crate::conversation_resources::tests_settings::Case;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::*;

fn archived(thread: &str, texts: &[(&str, &str, &str)]) -> ArchivedImportRequest {
    ArchivedImportRequest {
        source_instance: "synthetic-v1".into(),
        source_thread_id: thread.into(),
        snapshot_id: format!("snapshot-{thread}"),
        messages: texts
            .iter()
            .enumerate()
            .map(|(i, (role, text, at))| ArchivedMessage {
                source_message_id: format!("{thread}-m{i}"),
                source_position: i as i64 + 1,
                source_cursor: i as i64 + 1,
                role: (*role).into(),
                phase: None,
                state: Some("completed".into()),
                source_kind: None,
                created_at: Some((*at).into()),
                updated_at: None,
                text: (*text).into(),
                attachments: vec![],
            })
            .collect(),
    }
}

async fn accepted_reply(case: &Case, conversation: &ConversationId, sequence: i64) {
    sqlx::query("UPDATE conversations SET sequence=? WHERE id=?")
        .bind(sequence)
        .bind(conversation.to_string())
        .execute(&case.store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO events(id,owner_id,conversation_id,sequence,kind,schema_version) VALUES(?,?,?,?,'execution_accepted',9)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(case.owner.to_string())
        .bind(conversation.to_string())
        .bind(sequence)
        .execute(&case.store.pool)
        .await
        .unwrap();
}

fn find<'a>(list: &'a SidebarConversations, id: &ConversationId) -> &'a SidebarConversation {
    list.conversations
        .iter()
        .find(|c| &c.conversation_id == id)
        .unwrap()
}

#[tokio::test]
async fn activity_preview_and_unread_follow_owner_views() {
    let case = Case::new().await;
    let chat = case.conversation("synthetic-chat").await;
    case.store
        .admit(
            &case.owner,
            &chat,
            &MessageInput {
                client_message_id: "m-1".into(),
                text: "Synthetic question".into(),
            },
        )
        .await
        .unwrap();
    let list = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    let row = find(&list, &chat);
    assert_eq!(row.sequence, 1);
    assert!(row.last_event_at.is_some());
    assert_eq!(
        row.preview,
        Some((SidebarAuthor::Owner, "Synthetic question".into()))
    );
    assert_eq!(row.unread, 0);

    // Two replies after the owner's message are unread until viewed.
    accepted_reply(&case, &chat, 2).await;
    accepted_reply(&case, &chat, 3).await;
    let list = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    assert_eq!(find(&list, &chat).unread, 2);
    let key = SidebarKey::V2(chat.clone());
    assert_eq!(
        case.store
            .mark_sidebar_read(&case.token, &case.owner, &key, 2)
            .await
            .unwrap(),
        2
    );
    let list = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    assert_eq!(find(&list, &chat).unread, 1);
    // Marks never move back and never pass the conversation sequence.
    assert_eq!(
        case.store
            .mark_sidebar_read(&case.token, &case.owner, &key, 1)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        case.store
            .mark_sidebar_read(&case.token, &case.owner, &key, 4)
            .await,
        Err(ResourceError::Invalid)
    );
    case.store
        .mark_sidebar_read(&case.token, &case.owner, &key, 3)
        .await
        .unwrap();
    let v1 = SidebarKey::V1("synthetic-thread".into());
    case.store
        .mark_sidebar_read(&case.token, &case.owner, &v1, 40)
        .await
        .unwrap();
    let list = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    assert_eq!(find(&list, &chat).unread, 0);
    assert_eq!(list.v1_marks.get("synthetic-thread"), Some(&40));
    assert_eq!(
        case.store
            .sidebar_conversations("wrong-credential", &case.owner)
            .await,
        Err(ResourceError::Unauthorized)
    );
    case.finish().await;
}

#[tokio::test]
async fn imported_sub_threads_keep_a_write_once_parent_link() {
    let case = Case::new().await;
    let child = case.conversation("synthetic-worker").await;
    case.store
        .import_archived_history(
            &case.token,
            &case.owner,
            &child,
            &archived(
                "worker-parent-1",
                &[
                    ("user", "Synthetic start", "2026-01-01T00:00:00.000Z"),
                    ("assistant", "Synthetic done", "2026-01-02T00:00:00.000Z"),
                ],
            ),
        )
        .await
        .unwrap();
    let lineage = ConversationLineage {
        source_instance: "synthetic-v1".into(),
        source_thread_id: "worker-parent-1".into(),
        source_parent_thread_id: Some("parent".into()),
    };
    // Lineage must name an imported source of this conversation.
    let other = case.conversation("synthetic-other").await;
    assert_eq!(
        case.store
            .record_conversation_lineage(&case.token, &case.owner, &other, &lineage)
            .await,
        Err(ResourceError::Conflict("lineage_source_not_imported"))
    );
    assert!(case
        .store
        .record_conversation_lineage(&case.token, &case.owner, &child, &lineage)
        .await
        .unwrap());
    assert!(!case
        .store
        .record_conversation_lineage(&case.token, &case.owner, &child, &lineage)
        .await
        .unwrap());
    let changed = ConversationLineage {
        source_parent_thread_id: Some("another-parent".into()),
        ..lineage.clone()
    };
    assert_eq!(
        case.store
            .record_conversation_lineage(&case.token, &case.owner, &child, &changed)
            .await,
        Err(ResourceError::Conflict("lineage_conflict"))
    );
    let list = case
        .store
        .sidebar_conversations(&case.token, &case.owner)
        .await
        .unwrap();
    let row = find(&list, &child);
    assert_eq!(row.lineage.as_ref(), Some(&lineage));
    assert_eq!(row.source_thread_id.as_deref(), Some("worker-parent-1"));
    assert_eq!(
        row.last_archived_at.as_deref(),
        Some("2026-01-02T00:00:00.000Z")
    );
    assert_eq!(
        row.preview,
        Some((SidebarAuthor::Assistant, "Synthetic done".into()))
    );
    // The database itself refuses rewriting or dropping lineage.
    assert!(
        sqlx::query("UPDATE conversation_lineage SET source_parent_thread_id=NULL")
            .execute(&case.store.pool)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM conversation_lineage")
        .execute(&case.store.pool)
        .await
        .is_err());
    case.finish().await;
}
