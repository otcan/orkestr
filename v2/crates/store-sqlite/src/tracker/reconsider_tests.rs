//! Retry fairness and atomic failure of extracted evidence.
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
async fn pending_reconsideration_rotates_past_an_unmatched_first_page() {
    let c = Case::new().await;
    enabled(&c).await;
    let mut events = Vec::new();
    for n in 0..130 {
        let mut value = reply();
        value.message_ref = Some(format!("{:024x}", 1000 + n));
        if n != 129 {
            value.thread_refs = vec![format!("{:024x}", 4000 + n)];
        }
        events.push(value);
    }
    c.store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch("pending-page-one", events[..100].to_vec()),
        )
        .await
        .unwrap();
    c.store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch("pending-page-two", events[100..].to_vec()),
        )
        .await
        .unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='pending'")
            .await,
        130
    );
    c.store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch("late-sent", vec![sent()]),
        )
        .await
        .unwrap();
    c.store
        .record_tracker_scan(owner(&c), &c.conversation, 0, &[], "{}", "{}")
        .await
        .unwrap();
    assert_eq!(
        c.store
            .tracker_page(owner(&c), &c.conversation)
            .await
            .unwrap()
            .rows[0]
            .status,
        TrackerStatus::Interview
    );
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='resolved'")
            .await,
        1
    );
}

#[tokio::test]
async fn failed_evidence_write_rolls_back_rows_events_batches_and_cursor() {
    let c = Case::new().await;
    enabled(&c).await;
    sqlx::query("CREATE TRIGGER synthetic_unresolved_failure BEFORE INSERT ON tracker_unresolved_events BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END")
        .execute(&c.store.pool).await.unwrap();
    let mut unknown = reply();
    unknown.thread_refs = vec!["999999999999999999999999".into()];
    assert!(c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch("must-rollback", vec![sent(), unknown])
        )
        .await
        .is_err());
    for table in [
        "tracker_rows",
        "tracker_events",
        "tracker_batches",
        "tracker_ledger",
        "tracker_unresolved_events",
    ] {
        assert_eq!(c.count(&format!("SELECT count(*) FROM {table}")).await, 0);
    }
    assert!(c
        .store
        .tracker_config(owner(&c), &c.conversation)
        .await
        .unwrap()
        .cursor_json
        .is_none());
}
