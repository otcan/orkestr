//! Explicit private metadata rehearsal; no source DB, route or transport access.
//! Input is a reviewed canonical DTO array, never message payloads or credentials.
use orkestr_v2_contracts::AutomaticReplyPreservedInput;
use orkestr_v2_store_sqlite::Store;
use std::os::unix::fs::PermissionsExt;
use uuid::Uuid;

#[tokio::test]
async fn preserve_private_metadata_into_fresh_dormant_store() {
    let input = std::env::var_os("ORKESTR_PRESERVATION_INPUT").expect("explicit input required");
    let input = std::path::PathBuf::from(input);
    let metadata = std::fs::symlink_metadata(&input).unwrap();
    assert!(metadata.is_file() && metadata.permissions().mode() & 0o077 == 0);
    assert!(metadata.len() <= 1024 * 1024);
    let evidence: Vec<AutomaticReplyPreservedInput> =
        serde_json::from_slice(&std::fs::read(input).unwrap()).expect("invalid DTO array");
    assert!(!evidence.is_empty() && evidence.len() <= 128);
    let parent = std::path::PathBuf::from(
        std::env::var_os("ORKESTR_V2_HOME").expect("isolated home required"),
    );
    let root = parent.join(format!("private-preservation-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join("core.sqlite3");
    let store = Store::open(&path).await.unwrap();
    let conversation = store
        .setup("fake-rehearsal-owner", "fake-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("fake-rehearsal-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = Uuid::new_v4().to_string();
    store.save_session(&token, &owner).await.unwrap();
    let mut receipts = Vec::new();
    for item in &evidence {
        let receipt = store
            .preserve_automatic_reply_input_authenticated(&token, &conversation, item)
            .await
            .unwrap();
        assert!(receipt.dormant && receipt.never_replay);
        let replay = store
            .preserve_automatic_reply_input_authenticated(&token, &conversation, item)
            .await
            .unwrap();
        assert!(receipt == replay);
        receipts.push(receipt);
    }
    store.close().await;
    let reopened = Store::open(&path).await.unwrap();
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}?mode=ro", path.display()))
        .await
        .unwrap();
    for (item, receipt) in evidence.iter().zip(&receipts) {
        let row: (String, i64, i64, Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT provenance_json,dormant,held,route_id,route_generation FROM automatic_reply_inputs WHERE id=?",
        ).bind(receipt.input_id.to_string()).fetch_one(&pool).await.unwrap();
        let stored: AutomaticReplyPreservedInput = serde_json::from_str(&row.0).unwrap();
        // Boolean assertions prevent private metadata being printed on mismatch.
        assert!(stored == *item);
        assert!((row.1, row.2, row.3, row.4) == (1, 1, None, None));
        let replay = reopened
            .preserve_automatic_reply_input_authenticated(&token, &conversation, item)
            .await
            .unwrap();
        assert!(replay == *receipt);
    }
    for table in [
        "automatic_reply_routes",
        "automatic_reply_permissions",
        "automatic_reply_sends",
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(count == 0);
    }
    reopened.revoke_session(&token).await.unwrap();
    assert!(
        reopened
            .preserve_automatic_reply_input_authenticated(&token, &conversation, &evidence[0])
            .await
            .is_err()
    );
    pool.close().await;
    reopened.close().await;
    for entry in std::fs::read_dir(&root).unwrap() {
        std::fs::set_permissions(
            entry.unwrap().path(),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let receipt = serde_json::json!({"preserved_count": receipts.len(), "reopen": true,
        "exact_provenance": true, "dormant_held_never_replay": true,
        "no_routes_permissions_sends_native_work": true, "current_revocation_refused": true,
        "target": path, "scope": "isolated metadata preservation, no transport authority"});
    let receipt_path = root.join("rehearsal.json");
    std::fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    std::fs::set_permissions(receipt_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    println!("PRIVATE_PRESERVATION_PASS records={}", receipts.len());
}
