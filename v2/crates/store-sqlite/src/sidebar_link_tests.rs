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

#[tokio::test]
async fn thread_link_check_matches_what_the_sidebar_reports() {
    let c = Case::new().await;
    let linked = |thread: &'static str| {
        let (store, token, owner) = (c.store.clone(), c.token.clone(), c.owner.clone());
        async move {
            store
                .v1_thread_linked(&token, &owner, thread)
                .await
                .unwrap()
        }
    };
    assert!(!linked("thread-a").await, "nothing imported yet");
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
    // The sidebar reports a conversation's first archived source.
    assert!(linked("thread-a").await);
    assert!(!linked("thread-b").await);
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
    // A recorded lineage counts as well, without hiding the first source.
    assert!(linked("thread-b").await);
    assert!(linked("thread-a").await);
    assert!(!linked("thread-unknown").await);
    let provisioned = c.conversation("provisioned").await;
    assert!(!linked("thread-provisioned").await);
    sqlx::query("INSERT INTO whatsapp_chat_provisions(owner_id,request_key,conversation_id,name,v1_thread_id,remote_thread_id,stage,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,6,1,1)")
        .bind(c.owner.to_string())
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(provisioned.to_string())
        .bind("Synthetic provisioned")
        .bind("thread-provisioned")
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&c.store.pool)
        .await
        .unwrap();
    assert!(linked("thread-provisioned").await);
    // Scoped to the authenticated owner; a revoked session reads nothing.
    assert!(c
        .store
        .v1_thread_linked(&c.token, &OwnerId(uuid::Uuid::new_v4()), "thread-a")
        .await
        .is_err());
    c.store.revoke_session(&c.token).await.unwrap();
    assert!(c
        .store
        .v1_thread_linked(&c.token, &c.owner, "thread-a")
        .await
        .is_err());
    c.finish().await;
}
