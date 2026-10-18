//! Exact field-delta oracles. Fresh opaque values are validated, never printed.
use super::*;
use serde_json::Value;
use std::collections::BTreeMap;
pub(super) type Rows = BTreeMap<String, Vec<Value>>;
pub(super) async fn rows(root: &std::path::Path) -> Rows {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut result = Rows::new();
    for table in [
        "production_acceptances",
        "production_payloads",
        "production_cancellations",
        "production_control_outbox",
        "production_observations",
        "production_supervisors",
        "production_readiness",
        "production_runs",
        "production_run_leases",
        "reasoning_inbox",
        "session_bindings",
        "messages",
        "events",
        "outbox",
        "conversations",
        "execution_revisions",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| {
                let s: String = r.get("name");
                format!("'{s}',\"{s}\"")
            })
            .collect::<Vec<_>>()
            .join(",");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.insert(
            table.into(),
            values
                .iter()
                .map(|s| serde_json::from_str(s).unwrap())
                .collect(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}
