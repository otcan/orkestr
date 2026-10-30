//! Isolated synthetic process tests. No production path or credential discovery.
use super::*;
use crate::ConversationExportLimits;
use orkestr_v2_application::IntakeStore;

async fn seeded(path: &std::path::Path) -> (Store, OwnerId, ConversationId) {
    let store = Store::open(path).await.unwrap();
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
    store.save_session("synthetic-token", &owner).await.unwrap();
    (store, owner, conversation)
}
fn directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("migration-recovery-{}", Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    path
}
async fn collect(
    store: &Store,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> HistoryImportRequest {
    let mut cut = store
        .begin_conversation_export(
            "synthetic-token",
            owner,
            conversation,
            ConversationExportLimits::default(),
        )
        .await
        .unwrap();
    let cut_id = cut.receipt().cut_id;
    let mut request = HistoryImportRequest {
        namespace: Uuid::from_u128(11),
        source_digest: String::new(),
        source_conversation_id: conversation.clone(),
        source_scope: Scope::Global,
        source_watermark: 0,
        messages: Vec::new(),
    };
    let mut after = 0;
    loop {
        let page = cut
            .page("synthetic-token", owner, cut_id, after, 1)
            .await
            .unwrap();
        request.source_scope = page.scope;
        request.source_watermark = page.last_sequence;
        request.messages.extend(page.messages);
        match page.next_cursor {
            Some(next) => after = next,
            None => break,
        }
    }
    request.source_digest = history_source_digest(&request).unwrap();
    request
}
#[tokio::test]
async fn export_import_reopen_rollback_preserves_native_delta() {
    let root = directory();
    let (source, source_owner, conversation) = seeded(&root.join("source.sqlite3")).await;
    for index in 0..3 {
        source
            .admit(
                &source_owner,
                &conversation,
                &MessageInput {
                    client_message_id: format!("synthetic-source-{index}"),
                    text: format!("Synthetic Unicode é 🦀 {index}"),
                },
            )
            .await
            .unwrap();
    }
    let request = collect(&source, &source_owner, &conversation).await;
    let target_path = root.join("target.sqlite3");
    let (target, target_owner, target_conversation) = seeded(&target_path).await;
    assert_ne!(source_owner, target_owner);
    let imported = target
        .import_history("synthetic-token", &target_owner, &request)
        .await
        .unwrap();
    target
        .admit(
            &target_owner,
            &target_conversation,
            &MessageInput {
                client_message_id: "synthetic-v2-only-delta".into(),
                text: "Retained native V2 delta".into(),
            },
        )
        .await
        .unwrap();
    target.close().await;
    let target = Store::open(&target_path).await.unwrap();
    assert_eq!(
        target
            .import_history("synthetic-token", &target_owner, &request)
            .await
            .unwrap(),
        imported
    );
    assert_eq!(
        target
            .history_messages(
                "synthetic-token",
                &target_owner,
                request.namespace,
                None,
                100
            )
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        target
            .history_receipt("wrong-token", &target_owner, request.namespace)
            .await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        target
            .history_receipt("synthetic-token", &source_owner, request.namespace)
            .await,
        Err(HistoryError::Unauthorized)
    );
    let mut conflict = request.clone();
    conflict.messages.pop();
    conflict.source_digest = history_source_digest(&conflict).unwrap();
    assert_eq!(
        target
            .import_history("synthetic-token", &target_owner, &conflict)
            .await,
        Err(HistoryError::Conflict)
    );
    target
        .rollback_history(
            "synthetic-token",
            &target_owner,
            &HistoryRollbackRequest {
                namespace: request.namespace,
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    let delta = target
        .snapshot(&target_owner, &target_conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(delta.messages.len(), 1);
    assert_eq!(delta.messages[0].text, "Retained native V2 delta");
    let v2_delta = collect(&target, &target_owner, &target_conversation).await;
    assert_eq!(v2_delta.messages.len(), 1);
    let source_again = source
        .snapshot(&source_owner, &conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(source_again.messages.len(), 3);
    target.close().await;
    source.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

// The child exits without destructors or a graceful SQLite/pool shutdown. Its
// before-commit branch tests ledger transaction recovery, not an injected crash
// within import_history (which deliberately has no production crash hook).
#[tokio::test]
async fn crash_child() {
    let Some(root) = std::env::var_os("MIGRATION_SYNTHETIC_CRASH_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    assert_eq!(root.parent().unwrap(), std::env::temp_dir());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("migration-recovery-"));
    let mode = std::env::var("MIGRATION_SYNTHETIC_CRASH_MODE").unwrap();
    let store = Store::open(&root.join("crash.sqlite3")).await.unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let mut request = HistoryImportRequest {
        namespace: Uuid::from_u128(22),
        source_digest: String::new(),
        source_conversation_id: ConversationId(Uuid::from_u128(23)),
        source_scope: Scope::Global,
        source_watermark: 1,
        messages: vec![Message {
            message_id: MessageId(Uuid::from_u128(24)),
            sequence: 1,
            actor_kind: "owner".into(),
            text: "Synthetic crash history".into(),
            reply_to: None,
            origin: None,
        }],
    };
    request.source_digest = history_source_digest(&request).unwrap();
    if mode == "before-commit" {
        let mut tx = store
            .history_transaction("synthetic-token", &owner, true)
            .await
            .unwrap();
        sqlx::query("INSERT INTO history_imports(owner_id,namespace,source_digest,source_conversation_id,source_scope,source_watermark,message_count) VALUES(?,?,?,?,'global',1,1)")
            .bind(owner.to_string()).bind(request.namespace.to_string()).bind(&request.source_digest)
            .bind(request.source_conversation_id.to_string()).execute(&mut *tx).await.unwrap();
        std::process::exit(86);
    }
    assert_eq!(mode, "after-receipt");
    store
        .import_history("synthetic-token", &owner, &request)
        .await
        .unwrap();
    std::process::exit(86);
}
#[tokio::test]
async fn abrupt_process_exit_uncommitted_and_acknowledged_batches() {
    let root = directory();
    let path = root.join("crash.sqlite3");
    let (store, owner, _) = seeded(&path).await;
    store.close().await;
    for mode in ["before-commit", "after-receipt"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_import::recovery_tests::crash_child",
                "--test-threads=1",
            ])
            .env("MIGRATION_SYNTHETIC_CRASH_ROOT", &root)
            .env("MIGRATION_SYNTHETIC_CRASH_MODE", mode)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let reopened = Store::open(&path).await.unwrap();
        let receipt = reopened
            .history_receipt("synthetic-token", &owner, Uuid::from_u128(22))
            .await;
        if mode == "before-commit" {
            assert_eq!(receipt, Err(HistoryError::NotFound));
        } else {
            assert!(receipt.unwrap().active);
            assert_eq!(
                reopened
                    .history_messages("synthetic-token", &owner, Uuid::from_u128(22), None, 100)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&reopened.pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&reopened.pool)
            .await
            .unwrap();
        assert!(violations.is_empty());
        reopened.close().await;
    }
    std::fs::remove_dir_all(root).unwrap();
}
