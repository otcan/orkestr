use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{MessageInput, OwnerId, ProjectInput};

async fn fixture() -> (std::path::PathBuf, Store, OwnerId, ConversationId) {
    let root = std::env::temp_dir().join(format!("native-conversations-{}", Uuid::new_v4()));
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
    store
        .save_session("browser:synthetic-current", &owner)
        .await
        .unwrap();
    (root, store, owner, home)
}
fn input(key: &str, name: &str) -> ConversationInput {
    ConversationInput {
        client_request_id: key.into(),
        name: name.into(),
    }
}

#[tokio::test]
async fn new_threads_preserve_home_projects_and_isolate_history_without_execution() {
    let (root, store, owner, home) = fixture().await;
    let project = store
        .create_project(
            &owner,
            &ProjectInput {
                client_request_id: "project-one".into(),
                name: "Synthetic project".into(),
            },
        )
        .await
        .unwrap();
    let (a, duplicate) = store
        .create_conversation_authenticated(
            "browser:synthetic-current",
            &input("thread-a", "Rust workbench"),
        )
        .await
        .unwrap();
    assert!(!duplicate);
    let (b, _) = store
        .create_conversation_authenticated(
            "browser:synthetic-current",
            &input("thread-b", "Second task"),
        )
        .await
        .unwrap();
    assert_ne!(a.conversation_id, b.conversation_id);
    assert_ne!(a.conversation_id, home);
    assert_eq!(store.global(&owner).await.unwrap(), home);
    store
        .admit(
            &owner,
            &a.conversation_id,
            &MessageInput {
                client_message_id: "first-message".into(),
                text: "Synthetic task".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .snapshot(&owner, &a.conversation_id, 0, 10)
            .await
            .unwrap()
            .messages
            .len(),
        1
    );
    assert!(store
        .snapshot(&owner, &b.conversation_id, 0, 10)
        .await
        .unwrap()
        .messages
        .is_empty());
    let page = store
        .conversations_authenticated("browser:synthetic-current", 0, 100)
        .await
        .unwrap();
    assert_eq!(page.conversations.len(), 4);
    assert_eq!(page.conversations[0].conversation_id, home);
    assert_eq!(
        page.conversations[1].conversation_id,
        project.project.conversation_id
    );
    for table in [
        "production_runs",
        "execution_windows",
        "production_supervisors",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    store.close().await;
    let reopened = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert_eq!(reopened.global(&owner).await.unwrap(), home);
    assert_eq!(
        reopened
            .snapshot(&owner, &a.conversation_id, 0, 10)
            .await
            .unwrap()
            .messages
            .len(),
        1
    );
    reopened.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn creation_is_idempotent_current_authenticated_and_paginates_without_duplicates() {
    let (root, store, owner, _) = fixture().await;
    let request = input("thread-a", "First task");
    let (first, _) = store
        .create_conversation_authenticated("browser:synthetic-current", &request)
        .await
        .unwrap();
    let (replayed, duplicate) = store
        .create_conversation_authenticated("browser:synthetic-current", &request)
        .await
        .unwrap();
    assert!(duplicate);
    assert_eq!(first.conversation_id, replayed.conversation_id);
    assert!(matches!(
        store
            .create_conversation_authenticated(
                "browser:synthetic-current",
                &input("thread-a", "Changed task")
            )
            .await,
        Err(Error::Conflict)
    ));
    let first_page = store
        .conversations_authenticated("browser:synthetic-current", 0, 1)
        .await
        .unwrap();
    let second_page = store
        .conversations_authenticated(
            "browser:synthetic-current",
            first_page.next_cursor.unwrap(),
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        second_page.conversations[0].conversation_id,
        first.conversation_id
    );
    assert!(second_page.next_cursor.is_none());
    assert!(store
        .snapshot(&OwnerId(Uuid::new_v4()), &first.conversation_id, 0, 10)
        .await
        .is_err());
    store
        .revoke_session("browser:synthetic-current")
        .await
        .unwrap();
    assert!(matches!(
        store
            .conversations_authenticated("browser:synthetic-current", 0, 10)
            .await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        store
            .create_conversation_authenticated("browser:synthetic-current", &request)
            .await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        store.global(&owner).await.unwrap(),
        first_page.conversations[0].conversation_id
    );
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn invalid_names_keys_and_cursors_do_not_create_threads() {
    let (root, store, _, _) = fixture().await;
    for request in [
        input("", "Task"),
        input("bad/key", "Task"),
        input("valid", "   "),
        input("valid", "bad\nname"),
        input("valid", &"x".repeat(121)),
    ] {
        assert!(matches!(
            store
                .create_conversation_authenticated("browser:synthetic-current", &request)
                .await,
            Err(Error::InvalidInput)
        ));
    }
    for (after, limit) in [(-1, 1), (0, 0), (0, 101)] {
        assert!(matches!(
            store
                .conversations_authenticated("browser:synthetic-current", after, limit)
                .await,
            Err(Error::InvalidInput)
        ));
    }
    assert_eq!(
        store
            .conversations_authenticated("browser:synthetic-current", 0, 100)
            .await
            .unwrap()
            .conversations
            .len(),
        1
    );
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
