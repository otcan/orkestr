use super::*;

async fn fixture() -> (Store, OwnerId, ConversationId, std::path::PathBuf) {
    let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    std::fs::create_dir_all(&home).unwrap();
    let path = home.join(format!("source-{}.sqlite3", Uuid::new_v4()));
    let store = Store::open(&path).await.unwrap();
    let conversation = store
        .setup("synthetic-source-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-source-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store.save_session("browser:human", &owner).await.unwrap();
    (store, owner, conversation, path)
}

async fn admit(
    store: &Store,
    owner: &OwnerId,
    conversation: &ConversationId,
    credential: &str,
    key: &str,
) -> Result<Admission> {
    store
        .admit_authenticated_attributed(
            credential,
            owner,
            conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: "synthetic owner-labelled text".into(),
            },
            None,
            None,
            None,
            Some(InputAuthor::Owner),
        )
        .await
}

async fn close(store: Store, path: std::path::PathBuf) {
    store.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn claimed_owner_never_promotes_machine_service_or_legacy_request_origin() {
    let (store, owner, conversation, path) = fixture().await;
    store.save_session("machine-token", &owner).await.unwrap();
    store.save_session("legacy-token", &owner).await.unwrap();
    sqlx::query("UPDATE auth_sessions SET kind='legacy' WHERE token_hash=?")
        .bind(digest("legacy-token"))
        .execute(&store.pool)
        .await
        .unwrap();
    let secret = "a".repeat(64);
    store
        .create_service_credential(
            "browser:human",
            "synthetic-hash",
            "synthetic bridge",
            &secret,
        )
        .await
        .unwrap()
        .unwrap();
    store
        .exchange_service_session(&secret, "browser:service")
        .await
        .unwrap()
        .unwrap();
    for (credential, kind) in [
        ("browser:human", "browser"),
        ("machine-token", "machine"),
        ("legacy-token", "legacy"),
        ("browser:service", "service_browser"),
    ] {
        let admitted = admit(&store, &owner, &conversation, credential, kind)
            .await
            .unwrap();
        let row:(String,String,String) = sqlx::query_as("SELECT s.owner_id,s.session_kind,a.author FROM message_request_sources s JOIN message_authors a ON a.message_id=s.message_id WHERE s.message_id=?")
            .bind(admitted.receipt.message_id.to_string()).fetch_one(&store.pool).await.unwrap();
        assert_eq!(row, (owner.to_string(), kind.into(), "owner".into()));
    }
    close(store, path).await;
}

#[tokio::test]
async fn replay_cannot_add_or_rewrite_request_provenance() {
    let (store, owner, conversation, path) = fixture().await;
    let input = MessageInput {
        client_message_id: "historical".into(),
        text: "synthetic owner-labelled text".into(),
    };
    let old = store
        .admit_attributed(
            &owner,
            &conversation,
            &input,
            None,
            None,
            None,
            Some(InputAuthor::Owner),
        )
        .await
        .unwrap();
    assert!(
        admit(&store, &owner, &conversation, "browser:human", "historical")
            .await
            .unwrap()
            .duplicate
    );
    let absent: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message_request_sources WHERE message_id=?")
            .bind(old.receipt.message_id.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(absent, 0);
    store.save_session("machine-token", &owner).await.unwrap();
    let first = admit(
        &store,
        &owner,
        &conversation,
        "machine-token",
        "original-machine",
    )
    .await
    .unwrap();
    assert!(
        admit(
            &store,
            &owner,
            &conversation,
            "browser:human",
            "original-machine"
        )
        .await
        .unwrap()
        .duplicate
    );
    let kind: String =
        sqlx::query_scalar("SELECT session_kind FROM message_request_sources WHERE message_id=?")
            .bind(first.receipt.message_id.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(kind, "machine");
    for query in [
        "UPDATE message_request_sources SET session_kind='browser'",
        "DELETE FROM message_request_sources",
    ] {
        assert!(sqlx::query(query).execute(&store.pool).await.is_err());
    }
    close(store, path).await;
}

#[tokio::test]
async fn revoked_expired_and_wrong_owner_credentials_cannot_admit_even_replays() {
    let (store, owner, conversation, path) = fixture().await;
    admit(&store, &owner, &conversation, "browser:human", "one")
        .await
        .unwrap();
    assert!(admit(
        &store,
        &OwnerId(Uuid::new_v4()),
        &conversation,
        "browser:human",
        "wrong-owner"
    )
    .await
    .is_err());
    sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
        .bind(digest("browser:human"))
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        admit(&store, &owner, &conversation, "browser:human", "expired")
            .await
            .is_err()
    );
    store.save_session("browser:new", &owner).await.unwrap();
    store.revoke_session("browser:new").await.unwrap();
    assert!(admit(&store, &owner, &conversation, "browser:new", "one")
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    close(store, path).await;
}

#[tokio::test]
async fn provider_fence_rolls_back_input_and_authentication_proof_together() {
    let (store, owner, conversation, path) = fixture().await;
    assert!(store
        .admit_authenticated_attributed(
            "browser:human",
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "wrong-generation".into(),
                text: "synthetic".into()
            },
            None,
            Some(42),
            None,
            Some(InputAuthor::Owner)
        )
        .await
        .is_err());
    for table in [
        "messages",
        "events",
        "message_request_sources",
        "reasoning_inbox",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    close(store, path).await;
}
