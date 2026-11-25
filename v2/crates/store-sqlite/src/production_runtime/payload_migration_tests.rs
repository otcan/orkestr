//! Migration 0102 widens one stored reply from 8 KiB to 32 KiB and keeps
//! every payload row exactly; its downgrade fixture restores schema 101.
use super::observation_tests::{consumed, input};
use super::tests::setup;
use super::*;
use crate::history_import::timers::scan_action::migration_fixture::downgrade_payload_bound;
use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES as MAX;
use orkestr_v2_contracts::PayloadId;

type Row = (i64, String, String, String, String, String, Option<String>);

async fn rows(store: &Store) -> Vec<Row> {
    sqlx::query_as(
        "SELECT rowid,id,event_id,owner_id,conversation_id,run_id,text FROM production_payloads ORDER BY rowid",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap()
}
async fn table_sql(store: &Store) -> String {
    sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='production_payloads'")
        .fetch_one(&store.pool)
        .await
        .unwrap()
}
async fn version(store: &Store) -> i64 {
    sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success=1")
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn schema101_upgrade_keeps_every_payload_and_admits_a_32_kib_reply() {
    let _real = crate::test_template::real_migrations();
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    // A full 8 KiB reply of two-byte letters, and a removed one (NULL text).
    for (sequence, text) in [(2, "ş".repeat(4096)), (3, "removed later".into())] {
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, sequence, ProviderEvent::Progress(text)),
            )
            .await
            .unwrap();
    }
    let removed: String = sqlx::query_scalar("SELECT id FROM production_payloads WHERE text=?")
        .bind("removed later")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    f.store
        .remove_provider_payload(
            &f.owner,
            &f.conversation,
            &PayloadId(Uuid::parse_str(&removed).unwrap()),
        )
        .await
        .unwrap();
    let before = rows(&f.store).await;
    assert_eq!(before.len(), 2);
    assert!(before.iter().any(|row| row.6.is_none()));
    assert!(table_sql(&f.store).await.contains("<=32768"));
    assert_eq!(version(&f.store).await, 102);

    // Back to exact schema 101 (the preflight would refuse anything else).
    downgrade_payload_bound(&f.store).await;
    assert!(table_sql(&f.store).await.contains("<=8192"));
    assert_eq!(version(&f.store).await, 101);
    assert_eq!(rows(&f.store).await, before);

    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(version(&upgraded).await, 102);
    assert!(table_sql(&upgraded).await.contains("<=32768"));
    assert_eq!(
        rows(&upgraded).await,
        before,
        "rows, rowids and NULL texts kept"
    );
    let index: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='production_payloads_run'")
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
    assert_eq!(
        index,
        "CREATE INDEX production_payloads_run ON production_payloads(run_id,owner_id)"
    );
    for table in ["production_payloads_before_32k", "production_payloads_32k"] {
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE name=?")
            .bind(table)
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
        assert_eq!(left, 0, "{table} is not left behind");
    }
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&upgraded.pool)
        .await
        .unwrap()
        .is_empty());

    // A whole 32 KiB reply is stored and read back unchanged.
    let reply = "ş".repeat(MAX / 2);
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 4, ProviderEvent::Progress(reply.clone())),
        )
        .await
        .unwrap();
    let id: String =
        sqlx::query_scalar("SELECT id FROM production_payloads WHERE length(CAST(text AS BLOB))=?")
            .bind(MAX as i64)
            .fetch_one(&upgraded.pool)
            .await
            .unwrap();
    let stored = upgraded
        .provider_payload(
            &f.owner,
            &f.conversation,
            &PayloadId(Uuid::parse_str(&id).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(stored.text.as_deref(), Some(reply.as_str()));
    // The table itself refuses one byte more, whatever the caller.
    let refused = sqlx::query("UPDATE production_payloads SET text=? WHERE id=?")
        .bind(format!("{reply}x"))
        .bind(&id)
        .execute(&upgraded.pool)
        .await;
    assert!(refused.is_err());
}
