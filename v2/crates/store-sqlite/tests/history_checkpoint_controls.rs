#![cfg(feature = "fixture-test-controls")]
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{ProductionCheckpoint, Store};
use uuid::Uuid;

#[tokio::test]
async fn history_probe_requires_current_exact_owner_and_fresh_marker_without_conversation() {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("history-checkpoint-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let db = root.join("core.sqlite3");
    let store = Store::open(&db).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = format!("browser:{}", "ab".repeat(32));
    store.save_session(&token, &owner).await.unwrap();
    for stage in [
        ProductionCheckpoint::HistoryImportBeforeCommit,
        ProductionCheckpoint::HistoryImportAfterCommit,
        ProductionCheckpoint::HistoryRollbackBeforeCommit,
        ProductionCheckpoint::HistoryRollbackAfterCommit,
    ] {
        let mut handle = Store::open(&db).await.unwrap();
        let marker = root.join(Uuid::new_v4().to_string());
        assert!(matches!(
            handle
                .production_arm_history_checkpoint("invalid", &owner, stage, marker.clone())
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(matches!(
            handle
                .production_arm_history_checkpoint(
                    &token,
                    &OwnerId(Uuid::new_v4()),
                    stage,
                    marker.clone()
                )
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        handle
            .production_arm_history_checkpoint(&token, &owner, stage, marker.clone())
            .await
            .unwrap();
        assert!(!marker.exists());
        assert!(matches!(
            handle
                .production_arm_history_checkpoint(&token, &owner, stage, marker)
                .await,
            Err(RuntimeStoreError::InvalidInput)
        ));
        handle.close().await;
    }
    let mut handle = Store::open(&db).await.unwrap();
    let marker = root.join("existing-marker");
    std::fs::write(&marker, b"preserve").unwrap();
    assert!(matches!(
        handle
            .production_arm_history_checkpoint(
                &token,
                &owner,
                ProductionCheckpoint::HistoryImportBeforeCommit,
                marker.clone()
            )
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    assert_eq!(std::fs::read(&marker).unwrap(), b"preserve");
    assert!(matches!(
        handle
            .production_arm_history_checkpoint(
                &token,
                &owner,
                ProductionCheckpoint::ConsumeBeforeCommit,
                root.join("wrong-stage")
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    store.revoke_session(&token).await.unwrap();
    assert!(matches!(
        handle
            .production_arm_history_checkpoint(
                &token,
                &owner,
                ProductionCheckpoint::HistoryImportBeforeCommit,
                root.join("revoked")
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    handle.close().await;
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
