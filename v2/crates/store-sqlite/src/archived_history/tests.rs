use super::*;
use std::path::PathBuf;
use uuid::Uuid;

struct Case {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
    token: String,
}
impl Case {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated test home"))
            .join(format!("archived-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        store.save_session(&token, &owner).await.unwrap();
        Self {
            root,
            store,
            owner,
            conversation,
            token,
        }
    }
    async fn import(&self, messages: Vec<ArchivedMessage>) -> Result<ArchivedImportReceipt> {
        self.store
            .import_archived_history(
                &self.token,
                &self.owner,
                &self.conversation,
                &batch(messages),
            )
            .await
    }
    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
fn message(position: i64, role: &str, text: &str) -> ArchivedMessage {
    ArchivedMessage {
        source_message_id: format!("msg-{position}"),
        source_position: position,
        source_cursor: position * 10,
        role: role.into(),
        phase: (role == "assistant").then(|| "final_answer".into()),
        state: Some("delivered".into()),
        source_kind: Some("web".into()),
        created_at: Some(format!("2026-01-0{position}T10:00:00.123Z")),
        updated_at: None,
        text: text.into(),
        attachments: vec![],
    }
}
fn batch(messages: Vec<ArchivedMessage>) -> ArchivedImportRequest {
    ArchivedImportRequest {
        source_instance: "synthetic-v1".into(),
        source_thread_id: "thread-a".into(),
        snapshot_id: "snapshot-1".into(),
        messages,
    }
}
fn range(from: i64, to: i64) -> Vec<ArchivedMessage> {
    (from..=to)
        .map(|p| {
            message(
                p,
                if p % 2 == 1 { "user" } else { "assistant" },
                &format!("synthetic {p} é"),
            )
        })
        .collect()
}

#[test]
fn pinned_digest_vector_matches_python_producer() {
    let mut value = message(1, "user", "hi é");
    value.attachments.push(ArchivedAttachment {
        name: "a.txt".into(),
        sha256: "0".repeat(64),
        bytes: 3,
        media_type: Some("text/plain".into()),
        available: true,
    });
    assert_eq!(archived_message_digest(&value), PINNED_DIGEST);
    // Volatile fields do not change identity.
    value.state = Some("archived".into());
    value.updated_at = Some("later".into());
    value.source_cursor = 99;
    assert_eq!(archived_message_digest(&value), PINNED_DIGEST);
    assert_eq!(archived_checksum_next("", PINNED_DIGEST), PINNED_CHAIN);
}
const PINNED_DIGEST: &str = "04a78502b2950c31549971e0bf3d46231da2f1fc90c20cd90502d97f478b6a9a";
const PINNED_CHAIN: &str = "48cfb477f978ae01f8ab07e5ea5022a42ede0749293c15ce86f5fbd2aa69551a";

#[tokio::test]
async fn ordered_import_is_idempotent_and_delta_extends_cursor() {
    let case = Case::new().await;
    let first = case.import(range(1, 3)).await.unwrap();
    assert_eq!((first.inserted, first.duplicates), (3, 0));
    assert_eq!((first.source.cursor, first.source.message_count), (3, 3));
    let again = case.import(range(1, 3)).await.unwrap();
    assert_eq!((again.inserted, again.duplicates), (0, 3));
    assert_eq!(again.source.checksum, first.source.checksum);
    let delta = case.import(range(1, 5)).await.unwrap();
    assert_eq!((delta.inserted, delta.duplicates), (2, 3));
    assert_eq!((delta.source.cursor, delta.source.message_count), (5, 5));
    let mut chain = String::new();
    for m in range(1, 5) {
        chain = archived_checksum_next(&chain, &archived_message_digest(&m));
    }
    assert_eq!(delta.source.checksum, chain);
    let page = case
        .store
        .archived_history_page(&case.token, &case.owner, &case.conversation, 0, 2)
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].message, range(1, 1)[0]);
    assert_eq!(page.entries[1].message.role, "assistant");
    let rest = case
        .store
        .archived_history_page(
            &case.token,
            &case.owner,
            &case.conversation,
            page.next_after.unwrap(),
            100,
        )
        .await
        .unwrap();
    assert_eq!(
        rest.entries
            .iter()
            .map(|e| e.message.source_position)
            .collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(rest.next_after.is_none());
    case.finish().await;
}

#[tokio::test]
async fn conflicts_are_quarantined_without_overwriting() {
    let case = Case::new().await;
    case.import(range(1, 4)).await.unwrap();
    let mut changed = message(2, "assistant", "edited later");
    changed.phase = Some("final_answer".into());
    let mut taken = message(3, "user", "other");
    taken.source_message_id = "foreign".into();
    let receipt = case
        .import(vec![changed.clone(), taken.clone()])
        .await
        .unwrap();
    let reasons: Vec<_> = receipt
        .quarantined
        .iter()
        .map(|q| q.reason.as_str())
        .collect();
    assert_eq!(reasons, ["content_changed", "position_conflict"]);
    let mut gap = message(9, "user", "gap");
    gap.source_message_id = "gap".into();
    case.import(vec![gap]).await.unwrap();
    let mut early = message(7, "user", "early");
    early.source_message_id = "early".into();
    let receipt = case.import(vec![early.clone()]).await.unwrap();
    assert_eq!(receipt.quarantined[0].reason, "out_of_order");
    case.import(vec![changed, taken, early]).await.unwrap();
    let status = case
        .store
        .archived_history_status(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    assert_eq!(status.sources.len(), 1);
    assert_eq!(
        (
            status.sources[0].message_count,
            status.sources[0].quarantined
        ),
        (5, 3)
    );
    let page = case
        .store
        .archived_history_page(&case.token, &case.owner, &case.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.entries[1].message.text, "synthetic 2 é");
    case.finish().await;
}

#[tokio::test]
async fn archive_never_touches_native_or_execution_tables_and_is_append_only() {
    let case = Case::new().await;
    let tables = [
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
        "history_imports",
    ];
    let mut before = Vec::new();
    for t in tables {
        before.push(case.count(t).await);
    }
    case.import(range(1, 6)).await.unwrap();
    for (t, b) in tables.iter().zip(before) {
        assert_eq!(case.count(t).await, b, "{t}");
    }
    let sequence: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
        .bind(case.conversation.to_string())
        .fetch_one(&case.store.pool)
        .await
        .unwrap();
    assert_eq!(sequence, 0);
    for sql in [
        "UPDATE archived_history_messages SET text='x'",
        "DELETE FROM archived_history_messages",
    ] {
        assert!(sqlx::query(sql).execute(&case.store.pool).await.is_err());
    }
    sqlx::query("DROP TRIGGER archived_history_messages_immutable")
        .execute(&case.store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE archived_history_messages SET text='tampered' WHERE source_position=2")
        .execute(&case.store.pool)
        .await
        .unwrap();
    assert_eq!(
        case.store
            .archived_history_page(&case.token, &case.owner, &case.conversation, 0, 10)
            .await
            .unwrap_err(),
        HistoryError::Conflict
    );
    case.finish().await;
}

#[tokio::test]
async fn authentication_ownership_and_validation_fail_closed() {
    let case = Case::new().await;
    let request = batch(range(1, 2));
    let store = &case.store;
    assert_eq!(
        store
            .import_archived_history("wrong", &case.owner, &case.conversation, &request)
            .await
            .unwrap_err(),
        HistoryError::Unauthorized
    );
    let foreign = ConversationId(Uuid::new_v4());
    assert_eq!(
        store
            .import_archived_history(&case.token, &case.owner, &foreign, &request)
            .await
            .unwrap_err(),
        HistoryError::NotFound
    );
    let mut invalid = Vec::new();
    invalid.push(batch(vec![]));
    invalid.push(batch(vec![
        message(2, "user", "a"),
        message(1, "user", "b"),
    ]));
    let mut dup = range(1, 2);
    dup[1].source_message_id = dup[0].source_message_id.clone();
    invalid.push(batch(dup));
    invalid.push(batch(vec![message(1, "User!", "a")]));
    let mut big = message(1, "user", "");
    big.text = "x".repeat(ARCHIVED_TEXT_MAX + 1);
    invalid.push(batch(vec![big]));
    let mut bad_attachment = message(1, "user", "a");
    bad_attachment.attachments.push(ArchivedAttachment {
        name: "missing".into(),
        sha256: "abc".into(),
        bytes: 0,
        media_type: None,
        available: false,
    });
    invalid.push(batch(vec![bad_attachment]));
    for request in invalid {
        assert_eq!(
            store
                .import_archived_history(&case.token, &case.owner, &case.conversation, &request)
                .await
                .unwrap_err(),
            HistoryError::Invalid
        );
    }
    assert_eq!(
        store
            .archived_history_page(&case.token, &case.owner, &case.conversation, 0, 101)
            .await
            .unwrap_err(),
        HistoryError::Invalid
    );
    store.revoke_session(&case.token).await.unwrap();
    assert_eq!(
        store
            .archived_history_status(&case.token, &case.owner, &case.conversation)
            .await
            .unwrap_err(),
        HistoryError::Unauthorized
    );
    assert_eq!(case.count("archived_history_messages").await, 0);
    case.finish().await;
}
