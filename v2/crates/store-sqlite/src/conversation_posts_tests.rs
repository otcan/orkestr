use super::*;
use crate::conversation_resources::tests_settings::Case;

fn request(key: &str, text: &str) -> ConversationPostRequest {
    ConversationPostRequest {
        request_key: key.into(),
        author: ConversationPostAuthor::Coordinator,
        label: None,
        text: text.into(),
        provider: Some("claude".into()),
        model: Some("synthetic-model".into()),
    }
}

#[tokio::test]
async fn posts_are_idempotent_placed_listed_and_delivered_without_inputs() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    const INPUTS: &str = "SELECT (SELECT count(*) FROM messages)+(SELECT count(*) FROM events)+(SELECT count(*) FROM reasoning_inbox)";
    let before = case.count(INPUTS).await;
    sqlx::query("UPDATE conversations SET sequence=7 WHERE id=?")
        .bind(chat.to_string())
        .execute(&case.store.pool)
        .await
        .unwrap();
    let first = case
        .store
        .create_conversation_post(&case.token, &case.owner, &chat, &request("k1", "Hello"))
        .await
        .unwrap();
    assert!(first.created);
    assert_eq!(first.post.label, "Coordinator");
    assert_eq!(first.post.after_sequence, 7);
    assert_eq!(first.post.delivered_ms, None);
    // Same key and body (an explicit default label is the same body).
    let mut explicit = request("k1", "Hello");
    explicit.label = Some("Coordinator".into());
    let again = case
        .store
        .create_conversation_post(&case.token, &case.owner, &chat, &explicit)
        .await
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.post, first.post);
    // Same key, different body.
    for changed in [
        request("k1", "Hello!"),
        ConversationPostRequest {
            author: ConversationPostAuthor::Operator,
            ..request("k1", "Hello")
        },
        ConversationPostRequest {
            model: None,
            ..request("k1", "Hello")
        },
    ] {
        assert_eq!(
            case.store
                .create_conversation_post(&case.token, &case.owner, &chat, &changed)
                .await,
            Err(ResourceError::Conflict("conversation_post_conflict"))
        );
    }
    // Strict validation.
    for bad in [
        request("", "x"),
        request("a b", "x"),
        request("k2", "  "),
        request("k2", "NO_REPLY"),
        request("k2", &"x".repeat(16_001)),
        ConversationPostRequest {
            label: Some(" padded".into()),
            ..request("k2", "x")
        },
        ConversationPostRequest {
            provider: Some("bad provider".into()),
            ..request("k2", "x")
        },
    ] {
        assert_eq!(
            case.store
                .create_conversation_post(&case.token, &case.owner, &chat, &bad)
                .await,
            Err(ResourceError::Invalid)
        );
    }
    // Unknown conversation, wrong credential.
    let unknown = ConversationId(Uuid::new_v4());
    assert_eq!(
        case.store
            .create_conversation_post(&case.token, &case.owner, &unknown, &request("k2", "x"))
            .await,
        Err(ResourceError::NotFound)
    );
    assert_eq!(
        case.store
            .create_conversation_post(&"0".repeat(64), &case.owner, &chat, &request("k2", "x"))
            .await,
        Err(ResourceError::Unauthorized)
    );

    sqlx::query("UPDATE conversations SET sequence=9 WHERE id=?")
        .bind(chat.to_string())
        .execute(&case.store.pool)
        .await
        .unwrap();
    let mut operator = request("k2", "Disk almost full");
    operator.author = ConversationPostAuthor::Operator;
    operator.label = Some("Ops alert".into());
    operator.provider = None;
    operator.model = None;
    let second = case
        .store
        .create_conversation_post(&case.token, &case.owner, &chat, &operator)
        .await
        .unwrap()
        .post;
    assert_eq!(
        (second.after_sequence, second.label.as_str()),
        (9, "Ops alert")
    );
    assert_eq!(
        case.count(INPUTS).await,
        before,
        "a post never creates input"
    );

    let list = |listing, limit| {
        let store = case.store.clone();
        let (token, owner, chat) = (case.token.clone(), case.owner.clone(), chat.clone());
        async move {
            store
                .conversation_posts(&token, &owner, &chat, listing, limit)
                .await
        }
    };
    let pending = list(PostListing::Pending, 20).await.unwrap();
    assert_eq!(
        pending.iter().map(|p| p.id).collect::<Vec<_>>(),
        vec![first.post.id, second.id]
    );
    assert_eq!(
        list(PostListing::Pending, 0).await,
        Err(ResourceError::Invalid)
    );
    assert_eq!(
        list(PostListing::Pending, 101).await,
        Err(ResourceError::Invalid)
    );
    let latest = list(PostListing::Latest, 1).await.unwrap();
    assert_eq!(latest, vec![second.clone()]);
    let after = list(PostListing::After(first.post.created_ms - 1), 10)
        .await
        .unwrap();
    assert_eq!(after.len(), 2);

    let delivered = case
        .store
        .deliver_conversation_post(&case.token, &case.owner, &chat, first.post.id)
        .await
        .unwrap();
    let at = delivered.delivered_ms.unwrap();
    let replay = case
        .store
        .deliver_conversation_post(&case.token, &case.owner, &chat, first.post.id)
        .await
        .unwrap();
    assert_eq!(replay.delivered_ms, Some(at), "replay keeps the first time");
    assert_eq!(
        list(PostListing::Pending, 20).await.unwrap(),
        vec![second.clone()]
    );
    assert_eq!(
        case.store
            .deliver_conversation_post(&case.token, &case.owner, &chat, Uuid::new_v4())
            .await,
        Err(ResourceError::NotFound)
    );
    // The row identity is fixed in SQL too.
    assert!(
        sqlx::query("UPDATE conversation_posts SET text='changed' WHERE id=?")
            .bind(second.id.to_string())
            .execute(&case.store.pool)
            .await
            .is_err()
    );
    case.finish().await;
}

#[tokio::test]
async fn posts_to_another_conversation_or_an_archived_chat_are_refused() {
    let case = Case::new().await;
    let other = case.conversation("synthetic-other").await;
    case.store
        .create_conversation_post(&case.token, &case.owner, &other, &request("k1", "Hi"))
        .await
        .unwrap();
    // The same key in another conversation is a different post.
    let main = case.conversation.clone();
    let mine = case
        .store
        .create_conversation_post(&case.token, &case.owner, &main, &request("k1", "Bye"))
        .await
        .unwrap();
    assert!(mine.created);
    // Acknowledging through the wrong conversation finds nothing.
    assert_eq!(
        case.store
            .deliver_conversation_post(&case.token, &case.owner, &other, mine.post.id)
            .await,
        Err(ResourceError::NotFound)
    );
    sqlx::query("INSERT INTO whatsapp_chat_provisions(owner_id,request_key,conversation_id,name,v1_thread_id,remote_thread_id,stage,archived,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,6,1,1,1)")
        .bind(case.owner.to_string())
        .bind("00000000-0000-4000-8000-000000000001")
        .bind(other.to_string())
        .bind("Synthetic chat")
        .bind("v1-synthetic")
        .bind("00000000-0000-4000-8000-000000000002")
        .execute(&case.store.pool)
        .await
        .unwrap();
    assert_eq!(
        case.store
            .create_conversation_post(&case.token, &case.owner, &other, &request("k2", "Hi"))
            .await,
        Err(ResourceError::Conflict("conversation_archived"))
    );
    case.finish().await;
}
