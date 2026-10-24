//! Immutable history, bounded late evidence and source/row scope fences.
use super::*;

fn reply() -> TrackerEventInput {
    let mut value = event(
        TrackerEventKind::InterviewInvite,
        "Unknown company",
        None,
        2000,
    );
    value.message_ref = Some("222222222222222222222222".into());
    value.requires_thread = true;
    value.thread_refs = vec!["111111111111111111111111".into()];
    value
}

fn sent() -> TrackerEventInput {
    let mut value = event(
        TrackerEventKind::Applied,
        "Fabrikam",
        Some("Engineer"),
        1000,
    );
    value.message_ref = Some("111111111111111111111111".into());
    value
}

#[tokio::test]
async fn reply_before_sent_is_retained_then_applied_once_without_replaying_drops() {
    let c = Case::new().await;
    enabled(&c).await;
    let chat = &c.conversation;
    let first = c
        .store
        .apply_tracker_events(owner(&c), chat, &batch("reply-first", vec![reply()]))
        .await
        .unwrap();
    assert_eq!(first.changes[0].kind, TrackerChangeKind::Unmatched);
    assert_eq!(c.count("SELECT count(*) FROM tracker_events").await, 0);
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='pending'")
            .await,
        1
    );
    let later = c
        .store
        .apply_tracker_events(owner(&c), chat, &batch("sent-later", vec![sent()]))
        .await
        .unwrap();
    assert_eq!(later.changes.len(), 2);
    let page = c.store.tracker_page(owner(&c), chat).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].status, TrackerStatus::Interview);
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='resolved'")
            .await,
        1
    );
    assert_eq!(c.count("SELECT count(*) FROM tracker_events").await, 2);
    c.store
        .apply_tracker_events(owner(&c), chat, &batch("sent-later", vec![sent()]))
        .await
        .unwrap();
    c.store
        .apply_tracker_events(
            owner(&c),
            chat,
            &batch("same-reply-new-request", vec![reply()]),
        )
        .await
        .unwrap();
    assert_eq!(c.count("SELECT count(*) FROM tracker_events").await, 2);
    let ledger: String = sqlx::query_scalar(
        "SELECT outcome FROM tracker_ledger WHERE message_ref='222222222222222222222222'",
    )
    .fetch_one(&c.store.pool)
    .await
    .unwrap();
    assert_eq!(ledger, "event");
}

#[tokio::test]
async fn source_change_quarantines_pending_evidence_and_stale_scan_cannot_commit() {
    let c = Case::new().await;
    enabled(&c).await;
    let chat = &c.conversation;
    c.store
        .apply_tracker_events(owner(&c), chat, &batch("old-source-reply", vec![reply()]))
        .await
        .unwrap();
    let config = c
        .store
        .set_tracker_source(
            &c.token,
            &c.owner,
            chat,
            Some(r#"{"profile":"synthetic-selected"}"#),
        )
        .await
        .unwrap();
    assert_eq!(config.source_revision, 1);
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='quarantined'")
            .await,
        1
    );
    assert!(matches!(
        c.store
            .record_tracker_scan(owner(&c), chat, 0, &[], "{}", "{}")
            .await,
        Err(ResourceError::Conflict("tracker_source_revision_mismatch"))
    ));
    assert!(c
        .store
        .tracker_config(owner(&c), chat)
        .await
        .unwrap()
        .cursor_json
        .is_none());
    for (cursor, summary) in [("invalid", "{}"), ("{}", "invalid")] {
        assert!(c
            .store
            .record_tracker_scan(
                owner(&c),
                chat,
                config.source_revision,
                &[],
                cursor,
                summary
            )
            .await
            .is_err());
    }
    c.store
        .apply_tracker_events(owner(&c), chat, &batch("new-source-sent", vec![sent()]))
        .await
        .unwrap();
    assert_eq!(
        c.store.tracker_page(owner(&c), chat).await.unwrap().rows[0].status,
        TrackerStatus::Applied
    );
    assert_eq!(c.count("SELECT count(*) FROM tracker_events").await, 1);
}

#[tokio::test]
async fn merge_preserves_original_events_and_is_semantically_idempotent() {
    let c = Case::new().await;
    enabled(&c).await;
    let chat = &c.conversation;
    let a = sent();
    let mut b = event(
        TrackerEventKind::Applied,
        "Other Company",
        Some("Other Role"),
        1000,
    );
    b.message_ref = Some("444444444444444444444444".into());
    c.store
        .apply_tracker_events(owner(&c), chat, &batch("two-rows", vec![a, b]))
        .await
        .unwrap();
    let page = c.store.tracker_page(owner(&c), chat).await.unwrap();
    let request = TrackerMerge {
        keep: page.rows[0].id,
        absorb: page.rows[1].id,
    };
    let snapshot = "SELECT json_array(id,owner_id,conversation_id,row_id,kind,occurred_ms,source,message_ref,sender_domain,evidence,classifier,confidence,recorded_ms) FROM tracker_events ORDER BY id";
    let before: Vec<String> = sqlx::query_scalar(snapshot)
        .fetch_all(&c.store.pool)
        .await
        .unwrap();
    let receipt = c
        .store
        .merge_tracker_rows(&c.token, &c.owner, chat, &request)
        .await
        .unwrap();
    let after: Vec<String> = sqlx::query_scalar(snapshot)
        .fetch_all(&c.store.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_rows").await,
        2,
        "absorbed history is retained"
    );
    assert_eq!(
        c.store
            .tracker_page(owner(&c), chat)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(
        c.store
            .tracker_row_events(owner(&c), chat, request.keep)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        c.store
            .merge_tracker_rows(&c.token, &c.owner, chat, &request)
            .await
            .unwrap(),
        receipt
    );
    for sql in [
        "UPDATE tracker_events SET source='changed'",
        "DELETE FROM tracker_events",
        "DELETE FROM tracker_row_merges",
    ] {
        assert!(sqlx::query(sql).execute(&c.store.pool).await.is_err());
    }
}

#[tokio::test]
async fn row_scope_foreign_keys_and_unknown_unreferenced_evidence_refuse_atomically() {
    let c = Case::new().await;
    enabled(&c).await;
    c.store
        .apply_tracker_events(owner(&c), &c.conversation, &batch("one-row", vec![sent()]))
        .await
        .unwrap();
    let row = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap()
        .rows[0]
        .id;
    let other = c.conversation("other-tracker").await;
    c.store
        .enable_tracker(
            &c.token,
            &c.owner,
            &other,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    assert!(sqlx::query(
        "INSERT INTO tracker_row_links(owner_id,conversation_id,link,row_id) VALUES(?,?,?,?)"
    )
    .bind(c.owner.to_string())
    .bind(other.to_string())
    .bind("https://example.invalid/job")
    .bind(row.to_string())
    .execute(&c.store.pool)
    .await
    .is_err());
    let mut invalid = reply();
    invalid.message_ref = None;
    invalid.thread_refs = vec!["999999999999999999999999".into()];
    assert!(c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch("unreferenced", vec![invalid])
        )
        .await
        .is_err());
    assert_eq!(c.count("SELECT count(*) FROM tracker_events").await, 1);
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events")
            .await,
        0
    );
}
