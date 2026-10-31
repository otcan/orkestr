use super::*;
use sqlx::{migrate::Migrate, sqlite::SqliteConnectOptions, Connection, SqliteConnection};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn populated_31_upgrade_preserves_legacy_output_without_inventing_native_calls() {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("native-tool-upgrade-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let options = SqliteConnectOptions::new()
        .filename(root.join("core.sqlite3"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in sqlx::migrate!("./migrations")
        .iter()
        .take_while(|m| m.version < 32)
    {
        conn.apply(migration).await.unwrap();
    }
    conn.close().await.unwrap();
    let store = Store {
        pool: sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap(),
        authority: None,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        workspace_handles: Default::default(),
        #[cfg(feature = "fixture-test-controls")]
        production_checkpoint: None,
        deep_burst_quiet_ms: 0,
    };
    let historical_guard =
        crate::production_runtime::historical_guard_fixture::HistoricalGuardFixture::install(
            &store, 31,
        )
        .await;
    let conversation = store
        .setup("synthetic-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let handle = store
        .authorize_supervisor(
            &token,
            crate::production_runtime::tests::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let f = Case {
        store,
        handle,
        root,
        owner,
        conversation,
        token,
    };
    let (_, parent) = worker(&f).await;
    let OfflinePythonAdmission::Fresh(g) = f
        .handle
        .delegate_offline_python_from_parent(&f.token, &parent, "legacy", "print(1)", 5000)
        .await
        .unwrap()
    else {
        panic!()
    };
    let launch = launch(&f, g).await;
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let receipt = f
        .handle
        .finish_offline_python(
            &f.token,
            &launch,
            OfflinePythonOutcome::Completed,
            &crate::digest("legacy-result"),
        )
        .await
        .unwrap();
    historical_guard.remove(&f.store).await;
    f.store.close().await;
    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let native: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_results")
        .fetch_one(&upgraded.pool)
        .await
        .unwrap();
    assert_eq!(
        native, 0,
        "old completed tools cannot gain retroactive native result authority"
    );
    let row = sqlx::query("SELECT * FROM worker_tool_delegations WHERE id=?")
        .bind(launch.id().to_string())
        .fetch_one(&upgraded.pool)
        .await
        .unwrap();
    assert_eq!(super::super::super::receipt(&row).unwrap(), receipt);
    let attached = f.handle.reattach_supervisor(&upgraded).await.unwrap();
    assert!(matches!(
        attached
            .prepare_offline_python_result(&f.token, &launch, &output())
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    upgraded.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    reopened.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
