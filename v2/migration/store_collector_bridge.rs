//! Synthetic integration test source for an admitted harness using registered Store.
//! No caller-selected database path, live token, provider or runtime is accepted.
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{ConversationExportLimits, Store};
use uuid::Uuid;

#[tokio::test]
async fn migration_collector_bridge() {
    // The admission owner supplies an isolated test home, never a production home.
    let root = std::path::PathBuf::from(
        std::env::var_os("ORKESTR_V2_HOME").expect("isolated synthetic test home required"),
    )
    .join(format!("migration-bridge-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
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
    for (index, text) in ["synthetic first", "synthetic ä 🦀 \u{7f}", "synthetic last"]
        .iter()
        .enumerate()
    {
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: format!("synthetic:{index}"),
                    text: (*text).into(),
                },
            )
            .await
            .unwrap();
    }
    let expected = store.snapshot(&owner, &conversation, 0, 100).await.unwrap();
    let mut export = store
        .begin_conversation_export(
            &token,
            &owner,
            &conversation,
            ConversationExportLimits::default(),
        )
        .await
        .unwrap();
    let cut = export.receipt().cut_id;
    // A post-cut synthetic write must not enter the exported messages.
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic:late".into(),
                text: "excluded late synthetic write".into(),
            },
        )
        .await
        .unwrap();
    let mut pages = Vec::new();
    let mut after = 0;
    loop {
        let page = export.page(&token, &owner, cut, after, 1).await.unwrap();
        let next = page.next_cursor;
        pages.push(page);
        match next {
            Some(cursor) => after = cursor,
            None => break,
        }
    }
    let mut refused = store
        .begin_conversation_export(
            &token,
            &owner,
            &conversation,
            ConversationExportLimits::default(),
        )
        .await
        .unwrap();
    let refused_cut = refused.receipt().cut_id;
    let partial = refused
        .page(&token, &owner, refused_cut, 0, 1)
        .await
        .unwrap();
    store.revoke_session(&token).await.unwrap();
    assert!(refused
        .page(&token, &owner, refused_cut, partial.next_cursor.unwrap(), 1)
        .await
        .is_err());
    // Only synthetic pages are emitted. Never adapt this to dump real exports.
    println!(
        "MIGRATION_BRIDGE:{}",
        serde_json::json!({
            "format_version": 1, "expected": expected, "pages": pages,
            "refused_partial_pages": [partial], "refusal_observed": true,
        })
    );
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
