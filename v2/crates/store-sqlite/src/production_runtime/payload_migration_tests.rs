//! Migration 0102 widens one stored reply from 8 KiB to 32 KiB and keeps
//! every payload row exactly; its downgrade fixture restores schema 101.
use super::observation_tests::{consumed, input};
use super::tests::setup;
use super::*;
use crate::history_import::timers::scan_action::migration_fixture::downgrade_payload_bound;
use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES as MAX;
use orkestr_v2_contracts::PayloadId;

type Row = (i64, String, String, String, String, String, Option<String>);

async fn rows_of(store: &Store) -> Vec<Row> {
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
    let before = rows_of(&f.store).await;
    assert_eq!(before.len(), 2);
    assert!(before.iter().any(|row| row.6.is_none()));
    assert!(table_sql(&f.store).await.contains("<=32768"));
    assert_eq!(version(&f.store).await, 102);

    // Back to exact schema 101 (the preflight would refuse anything else).
    downgrade_payload_bound(&f.store).await;
    assert!(table_sql(&f.store).await.contains("<=8192"));
    assert_eq!(version(&f.store).await, 101);
    assert_eq!(rows_of(&f.store).await, before);

    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(version(&upgraded).await, 102);
    assert!(table_sql(&upgraded).await.contains("<=32768"));
    assert_eq!(
        rows_of(&upgraded).await,
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

/// Set for the read-only child: the database it opens.
#[cfg(target_os = "linux")]
const READ_ONLY_CHILD: &str = "ORKESTR_V2_READ_ONLY_MIGRATION_CHILD";

/// The qualification starts Core on a read-only host where only its data
/// directory is writable, so SQLite has no temporary directory. Rebuilding
/// production_payloads (0102) spills a statement journal to a temporary file,
/// which failed the whole startup ("store startup failed",
/// SQLITE_IOERR_GETTEMPPATH). Migrations keep temporary storage in memory.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn schema101_upgrade_needs_no_writable_temporary_directory() {
    let _real = crate::test_template::real_migrations();
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    // Enough stored replies that dropping the old table spills its statement
    // journal (well over SQLite's 64 KiB in-memory statement journal).
    let run = p.run.run_id.to_string();
    let (owner, conversation) = (f.owner.to_string(), f.conversation.to_string());
    let mut tx = f.store.pool.begin().await.unwrap();
    let (lease, fence): (i64, i64) = sqlx::query_as(
        "SELECT lease_generation,dispatch_fence FROM production_observations WHERE run_id=? AND kind='started'",
    )
    .bind(&run)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let (sequence, run_sequence): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT max(sequence) FROM events WHERE conversation_id=?),(SELECT max(run_sequence) FROM production_observations WHERE run_id=?)",
    )
    .bind(&conversation)
    .bind(&run)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let rows = "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<300)";
    sqlx::query(&format!("{rows} INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) SELECT printf('00000000-0000-4000-8000-%012d',i),?,?,NULL,?+i,'provider_observed',8 FROM n"))
        .bind(&owner).bind(&conversation).bind(sequence)
        .execute(&mut *tx).await.unwrap();
    sqlx::query(&format!("{rows} INSERT INTO production_observations(event_id,run_id,run_sequence,semantic_digest,kind,lease_generation,dispatch_fence,receipt_state) SELECT printf('00000000-0000-4000-8000-%012d',i),?,?+i,printf('synthetic-%d',i),'progress',?,?,'running' FROM n"))
        .bind(&run).bind(run_sequence).bind(lease).bind(fence)
        .execute(&mut *tx).await.unwrap();
    sqlx::query(&format!("{rows} INSERT INTO production_payloads(id,event_id,owner_id,conversation_id,run_id,text) SELECT printf('10000000-0000-4000-8000-%012d',i),printf('00000000-0000-4000-8000-%012d',i),?,?,?,hex(randomblob(2000)) FROM n"))
        .bind(&owner).bind(&conversation).bind(&run)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    downgrade_payload_bound(&f.store).await;
    let before = rows_of(&f.store).await;
    assert!(before.len() > 300);

    // Store::open in a child on a read-only host: only the data directory is
    // writable, there is no TMPDIR, and the working directory is read-only.
    let database = f.root.join("core.sqlite3");
    let root = f.root.to_str().unwrap();
    let name = format!(
        "{}::read_only_host_child",
        module_path!().split_once("::").unwrap().1
    );
    let status = std::process::Command::new("/usr/bin/bwrap")
        .args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
        .args([
            "--bind",
            root,
            root,
            "--unshare-pid",
            "--unshare-net",
            "--chdir",
            "/",
        ])
        .args(["--unsetenv", "TMPDIR", "--unsetenv", "SQLITE_TMPDIR"])
        .args(["--setenv", READ_ONLY_CHILD, database.to_str().unwrap()])
        .arg(std::env::current_exe().unwrap())
        .args([
            name.as_str(),
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .status()
        .expect("bubblewrap is required for this test");
    assert!(
        status.success(),
        "Store::open on a read-only host: {status}"
    );

    let upgraded = Store::open(&database).await.unwrap();
    assert_eq!(version(&upgraded).await, 102);
    assert_eq!(rows_of(&upgraded).await, before);
}

/// Run only by the test above, inside its read-only bubblewrap child.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "child of schema101_upgrade_needs_no_writable_temporary_directory"]
async fn read_only_host_child() {
    let database = std::env::var(READ_ONLY_CHILD).expect("started by the read-only host test");
    // The conditions of the failure: no directory SQLite would use for a
    // temporary file is writable.
    for directory in ["/tmp", "/var/tmp", "/"] {
        let probe = std::path::Path::new(directory).join("orkestr-v2-temp-probe");
        assert!(
            std::fs::File::create(&probe).is_err(),
            "{directory} is writable"
        );
    }
    let store = Store::open(std::path::Path::new(&database)).await;
    assert!(store.is_ok(), "migrations need no temporary directory");
    assert_eq!(version(&store.unwrap()).await, 102);
}
