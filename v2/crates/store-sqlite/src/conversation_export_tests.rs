use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{MessageInput, ProjectInput};
use std::{collections::HashSet, path::PathBuf};

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
            .join(Uuid::new_v4().to_string());
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
    async fn admit(&self, key: &str, text: &str) {
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: text.into(),
                },
            )
            .await
            .unwrap();
    }
    async fn begin(&self, limits: ConversationExportLimits) -> Result<ConversationExport> {
        self.store
            .begin_conversation_export(&self.token, &self.owner, &self.conversation, limits)
            .await
    }
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
    async fn rows(&self) -> Vec<(String, Vec<String>)> {
        let mut connection = self.store.pool.acquire().await.unwrap();
        let mut tx = connection.begin().await.unwrap();
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .fetch_all(&mut *tx).await.unwrap();
        let mut result = Vec::new();
        for table in names {
            assert!(table
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_'));
            let columns = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
                .fetch_all(&mut *tx)
                .await
                .unwrap();
            let fields = columns
                .iter()
                .map(|column| {
                    let name: &str = column.get("name");
                    assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
                    // quote() handles the migration checksum BLOB without serializing secrets.
                    format!("'{name}',quote(\"{name}\")")
                })
                .collect::<Vec<_>>()
                .join(",");
            let rows = sqlx::query_scalar(&format!(
                "SELECT json_object({fields}) AS snapshot FROM \"{table}\" ORDER BY snapshot"
            ))
            .fetch_all(&mut *tx)
            .await
            .unwrap();
            result.push((table, rows));
        }
        tx.commit().await.unwrap();
        result
    }
}

#[tokio::test]
async fn concurrent_writer_cannot_move_cut_or_skip_duplicate_rows() {
    let case = Case::new().await;
    for i in 0..205 {
        case.admit(&format!("old:{i}"), &format!("synthetic {i}"))
            .await;
    }
    let original = case
        .store
        .snapshot(&case.owner, &case.conversation, 0, 100)
        .await
        .unwrap();
    let mut export = case
        .begin(ConversationExportLimits::default())
        .await
        .unwrap();
    let receipt = export.receipt().clone();
    assert_eq!(receipt.last_sequence, original.last_sequence);
    assert!(receipt.storage_schema_version >= 14);
    let writer = Store::open(&case.root.join("core.sqlite3")).await.unwrap();
    writer
        .admit(
            &case.owner,
            &case.conversation,
            &MessageInput {
                client_message_id: "late:0".into(),
                text: "after frozen cut".into(),
            },
        )
        .await
        .unwrap();
    // Even an unpaged live handle must not pin historical WAL frames.
    let checkpoint = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&writer.pool)
        .await
        .unwrap();
    assert_eq!(checkpoint.get::<i64, _>(0), 0);
    let owner = case.owner.clone();
    let conversation = case.conversation.clone();
    let writing = async {
        for i in 1..5 {
            writer
                .admit(
                    &owner,
                    &conversation,
                    &MessageInput {
                        client_message_id: format!("late:{i}"),
                        text: "after frozen cut".into(),
                    },
                )
                .await
                .unwrap();
        }
    };
    let reading = async {
        let mut after = 0;
        let mut messages = Vec::new();
        loop {
            let page = export
                .page(&case.token, &case.owner, receipt.cut_id, after, 37)
                .await
                .unwrap();
            assert_eq!(page.last_sequence, 205);
            assert_eq!(page.scope, Scope::Global);
            assert_eq!(page.conversation_id, case.conversation);
            messages.extend(page.messages);
            match page.next_cursor {
                Some(next) => after = next,
                None => break,
            }
        }
        messages
    };
    let (_, messages) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(writing, reading)
    })
    .await
    .expect("reader must not block writer");
    assert_eq!(messages.len(), 205);
    let ids: HashSet<_> = messages.iter().map(|m| m.message_id.clone()).collect();
    assert_eq!(ids.len(), 205);
    for (index, message) in messages.iter().enumerate() {
        assert_eq!(message.sequence, index as i64 + 1);
        assert_eq!(message.text, format!("synthetic {index}"));
    }
    let live = case
        .store
        .snapshot(&case.owner, &case.conversation, 205, 100)
        .await
        .unwrap();
    assert_eq!(live.last_sequence, 210);
    assert_eq!(live.messages.len(), 5);
    assert!(matches!(
        export
            .page(&case.token, &case.owner, receipt.cut_id, 0, 100)
            .await,
        Err(Error::Released)
    ));
    writer.close().await;
    case.finish().await;
}

#[tokio::test]
async fn authorization_cut_cursor_and_release_are_enforced_without_mutations() {
    let case = Case::new().await;
    for i in 0..3 {
        case.admit(&format!("input:{i}"), "synthetic").await;
    }
    let before = case.rows().await;
    let mut first = case
        .begin(ConversationExportLimits::default())
        .await
        .unwrap();
    let second = case
        .begin(ConversationExportLimits::default())
        .await
        .unwrap();
    let cut = first.receipt().cut_id;
    assert_ne!(cut, second.receipt().cut_id);
    let foreign = OwnerId(Uuid::new_v4());
    assert!(matches!(
        case.store
            .begin_conversation_export(
                &case.token,
                &foreign,
                &case.conversation,
                ConversationExportLimits::default()
            )
            .await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        first.page(&case.token, &foreign, cut, 0, 1).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        first.page("unrelated-token", &case.owner, cut, 0, 1).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        first
            .page(&case.token, &case.owner, second.receipt().cut_id, 0, 1)
            .await,
        Err(Error::WrongCut)
    ));
    assert!(matches!(
        first.page(&case.token, &case.owner, cut, 2, 1).await,
        Err(Error::Cursor)
    ));
    assert!(matches!(
        first.page(&case.token, &case.owner, cut, 0, 0).await,
        Err(Error::Invalid)
    ));
    let page = first
        .page(&case.token, &case.owner, cut, 0, 1)
        .await
        .unwrap();
    assert_eq!(page.next_cursor, Some(1));
    assert!(matches!(
        first.page(&case.token, &case.owner, cut, 0, 1).await,
        Err(Error::Cursor)
    ));
    first.release();
    first.release();
    assert!(matches!(
        first.page(&case.token, &case.owner, cut, 1, 1).await,
        Err(Error::Released)
    ));
    assert!(
        before == case.rows().await,
        "read-only export mutated a table"
    );
    drop((first, second));
    // query_only must never leak back into the writer pool.
    case.admit("still-writable", "synthetic writer remains usable")
        .await;
    case.finish().await;
}

#[tokio::test]
async fn current_revocation_denies_cached_data_and_cannot_be_undone_by_new_token() {
    let case = Case::new().await;
    for i in 0..3 {
        case.admit(&format!("input:{i}"), "synthetic").await;
    }
    let mut export = case
        .begin(ConversationExportLimits::default())
        .await
        .unwrap();
    let cut = export.receipt().cut_id;
    let first = export
        .page(&case.token, &case.owner, cut, 0, 1)
        .await
        .unwrap();
    let other = Store::open(&case.root.join("core.sqlite3")).await.unwrap();
    other.revoke_session(&case.token).await.unwrap();
    let next_token = "ab".repeat(32);
    other.save_session(&next_token, &case.owner).await.unwrap();
    let before = case.rows().await;
    assert!(matches!(
        export
            .page(&next_token, &case.owner, cut, first.next_cursor.unwrap(), 1)
            .await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        export
            .page(&case.token, &case.owner, cut, first.next_cursor.unwrap(), 1)
            .await,
        Err(Error::Unauthorized)
    ));
    assert!(export.snapshot.is_none());
    assert!(before == case.rows().await, "refused page mutated a table");
    assert!(matches!(
        case.begin(ConversationExportLimits::default()).await,
        Err(Error::Unauthorized)
    ));
    other.close().await;
    case.finish().await;
}

#[tokio::test]
async fn project_scope_and_empty_conversation_keep_the_published_contract() {
    let case = Case::new().await;
    case.admit("global:1", "excluded global message").await;
    let project = case
        .store
        .create_project(
            &case.owner,
            &ProjectInput {
                client_request_id: "project:1".into(),
                name: "Synthetic export project".into(),
            },
        )
        .await
        .unwrap()
        .project;
    let mut export = case
        .store
        .begin_conversation_export(
            &case.token,
            &case.owner,
            &project.conversation_id,
            ConversationExportLimits::default(),
        )
        .await
        .unwrap();
    let page = export
        .page(&case.token, &case.owner, export.receipt().cut_id, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        page.scope,
        Scope::Project {
            project_id: project.project_id
        }
    );
    assert_eq!(page.conversation_id, project.conversation_id);
    assert_eq!(page.last_sequence, 0);
    assert!(page.messages.is_empty());
    assert_eq!(page.next_cursor, None);
    let json = serde_json::to_value(page).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 5);
    assert_eq!(json["scope"]["kind"], "project");
    case.finish().await;
}

#[path = "conversation_export_limits_tests.rs"]
mod limits;
