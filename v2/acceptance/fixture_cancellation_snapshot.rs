//! Complete readonly transaction snapshots; private row values never leave memory.
use super::*;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::BTreeMap;
type Rows = BTreeMap<String, Vec<String>>;
pub(super) async fn snapshot(root: &Path) -> Rows {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(root.join("case.sqlite3"))
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
        "fixture_supervisors",
        "fixture_readiness",
        "fixture_runs",
        "fixture_observations",
        "reasoning_inbox",
        "session_bindings",
        "conversations",
        "events",
        "outbox",
        "fixture_run_leases",
        "fixture_cancellations",
        "fixture_control_outbox",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| {
                let n = r.get::<String, _>("name");
                format!("'{n}',\"{n}\"")
            })
            .collect::<Vec<_>>()
            .join(",");
        let rows = sqlx::query_scalar(&format!(
            "SELECT json_object({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.insert(table.into(), rows);
    }
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert!(violations.is_empty());
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}
pub(super) fn fingerprints(rows: &Rows) -> Value {
    json!(rows
        .iter()
        .map(|(name, rows)| {
            let mut hash = Sha256::new();
            for row in rows {
                hash.update((row.len() as u64).to_be_bytes());
                hash.update(row.as_bytes());
            }
            (name, format!("{:x}", hash.finalize()))
        })
        .collect::<BTreeMap<_, _>>())
}
pub(super) async fn expected(_root: &Path, baseline: &Rows, phase: &str) -> Value {
    let mut rows = baseline.clone();
    for (table, column, value) in [
        (
            "conversations",
            "sequence",
            json!(if phase.starts_with("cancel") { 2 } else { 3 }),
        ),
        (
            "fixture_runs",
            "state",
            json!(if phase.starts_with("cancel") {
                "cancel_requested"
            } else {
                "cancelled"
            }),
        ),
    ] {
        let mut row: Value = serde_json::from_str(&rows[table][0]).unwrap();
        row[column] = value;
        if table == "fixture_runs" && phase.starts_with("cancel") {
            row["reserve_key"] = Value::Null;
        }
        rows.get_mut(table).unwrap()[0] = serde_json::to_string(&row).unwrap();
    }
    if phase.starts_with("stopped") {
        let mut row: Value = serde_json::from_str(&rows["fixture_control_outbox"][0]).unwrap();
        row["state"] = json!("acknowledged");
        rows.get_mut("fixture_control_outbox").unwrap()[0] = serde_json::to_string(&row).unwrap();
    }
    // Normalize baseline encoding to the object serializer used for expected changes.
    for table in rows.values_mut() {
        for row in table {
            let v: Value = serde_json::from_str(row).unwrap();
            *row = serde_json::to_string(&v).unwrap();
        }
    }
    fingerprints(&rows)
}
pub(super) async fn assert_commit(root: &Path, rows: &Rows, phase: &str) {
    let mut normalized = rows.clone();
    for table in normalized.values_mut() {
        for row in table {
            let v: Value = serde_json::from_str(row).unwrap();
            *row = serde_json::to_string(&v).unwrap();
        }
    }
    let actual = fingerprints(&normalized);
    let expected = load(root, "expected.json");
    for name in [
        "fixture_supervisors",
        "fixture_readiness",
        "reasoning_inbox",
        "session_bindings",
        "fixture_runs",
        "conversations",
    ] {
        assert!(
            actual[name] == expected[name],
            "unexpected complete projection/authority change"
        );
    }
    if phase.starts_with("stopped") {
        for name in [
            "fixture_run_leases",
            "fixture_cancellations",
            "fixture_control_outbox",
        ] {
            assert!(
                actual[name] == expected[name],
                "unexpected lease/request/control mutation"
            );
        }
    }
    let prefix = load(root, "prefix.json");
    let prefix_map = Rows::from([
        (
            "events".into(),
            rows["events"][..if phase.starts_with("cancel") { 1 } else { 2 }].to_vec(),
        ),
        (
            "outbox".into(),
            rows["outbox"][..if phase.starts_with("cancel") { 1 } else { 2 }].to_vec(),
        ),
        (
            "fixture_run_leases".into(),
            rows["fixture_run_leases"][..if phase.starts_with("cancel") { 1 } else { 2 }].to_vec(),
        ),
    ]);
    // Prefix was recorded with the same three table names.
    assert!(
        prefix == fingerprints(&prefix_map),
        "historical prefix mutated"
    );
    assert_eq!(
        rows["events"].len(),
        if phase.starts_with("cancel") { 2 } else { 3 }
    );
    assert_eq!(rows["outbox"].len(), rows["events"].len());
    assert_eq!(rows["fixture_run_leases"].len(), 2);
    assert_eq!(rows["fixture_cancellations"].len(), 1);
    assert_eq!(rows["fixture_control_outbox"].len(), 1);
    assert_eq!(
        rows["fixture_observations"].len(),
        usize::from(phase.starts_with("stopped"))
    );
    let request: Value = serde_json::from_str(&rows["fixture_cancellations"][0]).unwrap();
    let lease: Value = serde_json::from_str(&rows["fixture_run_leases"][1]).unwrap();
    let control: Value = serde_json::from_str(&rows["fixture_control_outbox"][0]).unwrap();
    assert_eq!(request["lease_generation"], lease["generation"]);
    assert_eq!(request["dispatch_fence"], lease["dispatch_fence"]);
    assert_eq!(request["lease_deadline_ms"], lease["lease_deadline_ms"]);
    assert_eq!(lease["purpose"], "cancellation_acknowledgement");
    assert_eq!(request["receipt_state"], "cancel_requested");
    assert_eq!(request["inflight_status"], "unknown");
    assert_eq!(
        control["state"],
        if phase.starts_with("stopped") {
            "acknowledged"
        } else {
            "pending"
        }
    );
    assert_eq!(request["event_id"], control["event_id"]);
    assert_eq!(request["run_id"], control["run_id"]);
    save(root, "receipt-deadline.json", &request["lease_deadline_ms"]);
    if phase.starts_with("stopped") {
        let observation: Value = serde_json::from_str(&rows["fixture_observations"][0]).unwrap();
        assert_eq!(observation["receipt_state"], "cancelled");
        assert_eq!(observation["kind"], "stopped");
        save(root, "event-id.json", &observation["event_id"]);
    }
}
