use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{MessageInput, OwnerId, ReplyTo};

async fn fixture() -> (std::path::PathBuf, Store, OwnerId, ConversationId) {
    let root = std::env::temp_dir().join(format!("reply-to-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let home = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    (root, store, owner, home)
}
fn input(key: &str) -> MessageInput {
    MessageInput {
        client_message_id: key.into(),
        text: "[Replying to Orkestr message from 21:50: \"x\"]\n\nno need".into(),
    }
}
fn quote(text: &str) -> ReplyTo {
    ReplyTo {
        message_id: Some("true_chat_ABC".into()),
        author: Some("orkestr".into()),
        sent_at: Some("2026-01-02T21:50:00Z".into()),
        text: text.into(),
        is_own_reply: true,
        unavailable: false,
    }
}

#[tokio::test]
async fn the_quoted_message_is_stored_with_the_input_and_returned_in_the_snapshot() {
    let (root, store, owner, conversation) = fixture().await;
    let first = store
        .admit_with_reply_to(
            &owner,
            &conversation,
            &input("a"),
            Some(&quote("Should I look?")),
        )
        .await
        .unwrap();
    assert!(!first.duplicate);
    // A retry is the same input and never rewrites the stored quote.
    let retry = store
        .admit_with_reply_to(&owner, &conversation, &input("a"), Some(&quote("changed")))
        .await
        .unwrap();
    assert!(retry.duplicate);
    store
        .admit(&owner, &conversation, &input("b"))
        .await
        .unwrap();
    let unavailable = ReplyTo {
        message_id: None,
        author: None,
        sent_at: None,
        text: String::new(),
        is_own_reply: false,
        unavailable: true,
    };
    store
        .admit_with_reply_to(&owner, &conversation, &input("c"), Some(&unavailable))
        .await
        .unwrap();
    let snapshot = store.snapshot(&owner, &conversation, 0, 10).await.unwrap();
    let quotes: Vec<_> = snapshot
        .messages
        .iter()
        .map(|m| m.reply_to.clone())
        .collect();
    assert_eq!(
        quotes,
        [Some(quote("Should I look?")), None, Some(unavailable)]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn an_oversized_or_empty_quote_is_refused_and_admits_nothing() {
    let (root, store, owner, conversation) = fixture().await;
    let empty = ReplyTo {
        message_id: None,
        text: String::new(),
        ..quote("")
    };
    let huge = quote(&"x".repeat(ReplyTo::TEXT_MAX * 4 + 1));
    for bad in [empty, huge] {
        let result = store
            .admit_with_reply_to(&owner, &conversation, &input("z"), Some(&bad))
            .await;
        assert!(matches!(result, Err(StoreError::Invalid)));
    }
    assert!(store
        .snapshot(&owner, &conversation, 0, 10)
        .await
        .unwrap()
        .messages
        .is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn only_web_composer_messages_carry_the_web_origin_in_the_snapshot() {
    let (root, store, owner, conversation) = fixture().await;
    for key in [
        "web:00000000-0000-4000-8000-000000000001",
        "wa-intake-1",
        "timer:claim",
    ] {
        store
            .admit(&owner, &conversation, &input(key))
            .await
            .unwrap();
    }
    let snapshot = store.snapshot(&owner, &conversation, 0, 10).await.unwrap();
    let origins: Vec<_> = snapshot.messages.iter().map(|m| m.origin.clone()).collect();
    assert_eq!(origins, vec![Some("web".to_string()), None, None]);
    let json = serde_json::to_value(&snapshot.messages[1]).unwrap();
    assert!(
        json.get("origin").is_none(),
        "absent origin stays off the wire"
    );
    std::fs::remove_dir_all(root).unwrap();
}
