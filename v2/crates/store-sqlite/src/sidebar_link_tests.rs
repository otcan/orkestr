use super::*;

#[tokio::test]
async fn scoped_link_uses_the_same_precedence_without_other_conversation_projections() {
    let c = Case::new().await;
    for thread in ["thread-a", "thread-b"] {
        c.store
            .import_archived_history(
                &c.token,
                &c.owner,
                &c.conversation,
                &archived(thread, &[("user", "Synthetic", "2026-01-01T00:00:00Z")]),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        c.store
            .conversation_v1_link(&c.token, &c.owner, &c.conversation)
            .await
            .unwrap()
            .as_deref(),
        Some("thread-a")
    );
    c.store
        .record_conversation_lineage(
            &c.token,
            &c.owner,
            &c.conversation,
            &ConversationLineage {
                source_instance: "synthetic-v1".into(),
                source_thread_id: "thread-b".into(),
                source_parent_thread_id: None,
            },
        )
        .await
        .unwrap();
    let one = c
        .store
        .conversation_v1_link(&c.token, &c.owner, &c.conversation)
        .await
        .unwrap();
    assert_eq!(one.as_deref(), Some("thread-b"));
    let all = c
        .store
        .conversation_v1_links(&c.token, &c.owner)
        .await
        .unwrap();
    assert_eq!(
        all.iter().find(|(id, _)| *id == c.conversation).unwrap().1,
        one
    );
    assert!(c
        .store
        .conversation_v1_link("wrong", &c.owner, &c.conversation)
        .await
        .is_err());
    assert!(c
        .store
        .conversation_v1_link(&c.token, &OwnerId(uuid::Uuid::new_v4()), &c.conversation)
        .await
        .is_err());
    assert!(c
        .store
        .conversation_v1_link(&c.token, &c.owner, &ConversationId(uuid::Uuid::new_v4()))
        .await
        .is_err());
    c.store.revoke_session(&c.token).await.unwrap();
    assert!(c
        .store
        .conversation_v1_link(&c.token, &c.owner, &c.conversation)
        .await
        .is_err());
    c.finish().await;
}
