use orkestr_v2_domain::{ApplyError, ConversationKind, Envelope, Event, JournalRecord, TaskState};
use orkestr_v2_store_sqlite::{Error, Store};
use sqlx::{Connection, SqliteConnection};

fn record(id: &str, event: Event) -> JournalRecord {
    JournalRecord::new(Envelope {
        event_id: id.into(),
        event,
    })
}
fn home() -> JournalRecord {
    record(
        "e1",
        Event::ConversationCreated {
            id: "home".into(),
            kind: ConversationKind::Home,
            parent_id: None,
        },
    )
}
fn queued() -> JournalRecord {
    record(
        "e2",
        Event::TaskQueued {
            id: "task".into(),
            conversation_id: "home".into(),
        },
    )
}
async fn raw(path: &std::path::Path) -> SqliteConnection {
    SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(path))
        .await
        .unwrap()
}

#[tokio::test]
async fn reopen_replay_and_durable_original_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let store = Store::open(&path).await.unwrap();
    store.append(&home()).await.unwrap();
    store.append(&queued()).await.unwrap();
    store
        .append(&record(
            "e3",
            Event::TaskStarted {
                task_id: "task".into(),
                worker_id: "worker".into(),
            },
        ))
        .await
        .unwrap();
    store
        .append(&record(
            "e4",
            Event::TaskCompleted {
                task_id: "task".into(),
                worker_id: "worker".into(),
                result_ref: "result-1".into(),
            },
        ))
        .await
        .unwrap();
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.sequence, 4);
    assert!(matches!(
        snapshot.tasks["task"].state,
        TaskState::Completed { .. }
    ));
    store.close().await.unwrap();
    let store = Store::open(&path).await.unwrap();
    assert_eq!(store.snapshot().await.unwrap(), snapshot);
    assert_eq!(store.replay().await.unwrap(), snapshot);
    let concurrent_reopen = Store::open(&path).await.unwrap();
    assert_eq!(concurrent_reopen.replay().await.unwrap(), snapshot);
    concurrent_reopen.close().await.unwrap();
    let retry = store.append(&queued()).await.unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.sequence, 2);
    let mut changed = queued();
    changed.envelope.event = Event::TaskCancelled {
        task_id: "task".into(),
    };
    assert!(matches!(
        store.append(&changed).await,
        Err(Error::Domain(ApplyError::ConflictingEventId))
    ));
    assert_eq!(store.snapshot().await.unwrap(), snapshot);
    let mut raw = raw(&path).await;
    sqlx::raw_sql("DELETE FROM tasks; DELETE FROM conversations; DELETE FROM projection_cursor;")
        .execute(&mut raw)
        .await
        .unwrap();
    assert_eq!(store.replay().await.unwrap(), snapshot);
}

#[tokio::test]
async fn concurrent_handles_same_id_and_competing_claims() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let a = Store::open(&path).await.unwrap();
    let b = Store::open(&path).await.unwrap();
    let home = home();
    let (ra, rb) = tokio::join!(a.append(&home), b.append(&home));
    let (ra, rb) = (ra.unwrap(), rb.unwrap());
    assert_eq!(ra.sequence, rb.sequence);
    assert_ne!(ra.duplicate, rb.duplicate);
    a.append(&queued()).await.unwrap();
    let left = record(
        "claim-a",
        Event::TaskStarted {
            task_id: "task".into(),
            worker_id: "left".into(),
        },
    );
    let right = record(
        "claim-b",
        Event::TaskStarted {
            task_id: "task".into(),
            worker_id: "right".into(),
        },
    );
    let (ra, rb) = tokio::join!(a.append(&left), b.append(&right));
    assert_ne!(ra.is_ok(), rb.is_ok());
    assert_eq!(a.snapshot().await.unwrap().sequence, 3);
    assert_eq!(a.snapshot().await.unwrap(), b.replay().await.unwrap());
}

#[tokio::test]
async fn invalid_transitions_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("journal.sqlite"))
        .await
        .unwrap();
    let empty = store.snapshot().await.unwrap();
    let orphan = record(
        "orphan",
        Event::ConversationCreated {
            id: "child".into(),
            kind: ConversationKind::Topic,
            parent_id: Some("missing".into()),
        },
    );
    assert!(store.append(&orphan).await.is_err());
    assert!(store.append(&queued()).await.is_err());
    assert_eq!(store.snapshot().await.unwrap(), empty);
    store.append(&home()).await.unwrap();
    store.append(&queued()).await.unwrap();
    store
        .append(&record(
            "start",
            Event::TaskStarted {
                task_id: "task".into(),
                worker_id: "worker".into(),
            },
        ))
        .await
        .unwrap();
    let before = store.snapshot().await.unwrap();
    assert!(matches!(
        store
            .append(&record(
                "wrong",
                Event::TaskCompleted {
                    task_id: "task".into(),
                    worker_id: "imposter".into(),
                    result_ref: "result".into()
                }
            ))
            .await,
        Err(Error::Domain(ApplyError::WorkerMismatch))
    ));
    assert_eq!(store.snapshot().await.unwrap(), before);
    store
        .append(&record(
            "cancel",
            Event::TaskCancelled {
                task_id: "task".into(),
            },
        ))
        .await
        .unwrap();
    let before = store.snapshot().await.unwrap();
    assert!(store
        .append(&record(
            "restart",
            Event::TaskStarted {
                task_id: "task".into(),
                worker_id: "worker".into()
            }
        ))
        .await
        .is_err());
    assert_eq!(store.snapshot().await.unwrap(), before);
    assert_eq!(store.replay().await.unwrap(), before);
}

#[tokio::test]
async fn unsupported_or_corrupt_records_fail_without_projection_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let store = Store::open(&path).await.unwrap();
    store.append(&home()).await.unwrap();
    let before = store.snapshot().await.unwrap();
    let mut future = queued();
    future.schema_version = 2;
    assert!(matches!(
        store.append(&future).await,
        Err(Error::RecordVersion(2))
    ));
    let mut conn = raw(&path).await;
    for data in [
        serde_json::to_string(&future).unwrap(),
        "{malformed".into(),
        r#"{"schema_version":1,"envelope":{"event_id":"e2","event":{"NotKnown":{}}}}"#.into(),
        serde_json::to_string(&record(
            "e2",
            Event::TaskCancelled {
                task_id: "missing".into(),
            },
        ))
        .unwrap(),
    ] {
        sqlx::query("INSERT INTO journal VALUES (2, 'e2', ?)")
            .bind(data)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(store.replay().await.is_err());
        assert!(store.append(&queued()).await.is_err());
        assert_eq!(store.snapshot().await.unwrap(), before);
        assert!(Store::open(&path).await.is_err());
        sqlx::query("DELETE FROM journal WHERE sequence=2")
            .execute(&mut conn)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn wal_full_and_foreign_key_policy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let store = Store::open(&path).await.unwrap();
    store.append(&home()).await.unwrap();
    let mut conn = raw(&path).await;
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    // FULL and foreign_keys are connection-specific and tested on Store's own handle in unit tests.
}

#[tokio::test]
async fn concurrent_distinct_events_and_conflicting_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let a = Store::open(&path).await.unwrap();
    let b = Store::open(&path).await.unwrap();
    let first = home();
    let mut second = home();
    second.envelope.event = Event::ConversationCreated {
        id: "different".into(),
        kind: ConversationKind::Home,
        parent_id: None,
    };
    let (ra, rb) = tokio::join!(a.append(&first), b.append(&second));
    assert_ne!(ra.is_ok(), rb.is_ok());
    let one = record(
        "one",
        Event::ConversationCreated {
            id: "one".into(),
            kind: ConversationKind::Home,
            parent_id: None,
        },
    );
    let two = record(
        "two",
        Event::ConversationCreated {
            id: "two".into(),
            kind: ConversationKind::Home,
            parent_id: None,
        },
    );
    let (ra, rb) = tokio::join!(a.append(&one), b.append(&two));
    let (ra, rb) = (ra.unwrap(), rb.unwrap());
    assert_ne!(ra.sequence, rb.sequence);
    assert_eq!(a.replay().await.unwrap().sequence, 3);
}

#[tokio::test]
async fn projection_write_failure_rolls_back_journal_and_previous_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let store = Store::open(&path).await.unwrap();
    store.append(&home()).await.unwrap();
    let before = store.snapshot().await.unwrap();
    let mut conn = raw(&path).await;
    // Inject a storage failure after append begins; never part of an accepted schema.
    sqlx::raw_sql("CREATE TRIGGER fail_tasks BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").execute(&mut conn).await.unwrap();
    assert!(store.append(&queued()).await.is_err());
    assert_eq!(store.snapshot().await.unwrap(), before);
    sqlx::query("DROP TRIGGER fail_tasks")
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(store.replay().await.unwrap(), before);
    let receipt = store.append(&queued()).await.unwrap();
    assert_eq!(receipt.sequence, 2);
    assert!(!receipt.duplicate);
}
