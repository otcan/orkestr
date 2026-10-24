//! Review regressions: scope, provenance, bounded intake and immutable owner edits.
use super::*;
use crate::conversation_resources::now_ms;
use sqlx::Row;

fn pending(n: u32) -> TrackerEventInput {
    TrackerEventInput {
        message_ref: Some(format!("{n:024x}")),
        requires_thread: true,
        thread_refs: vec!["ffffffffffffffffffffffff".into()],
        evidence: Some("SYNTHETIC_PRIVATE_BODY_SENTINEL".into()),
        ..event(
            TrackerEventKind::InterviewInvite,
            "Unknown company",
            None,
            2000,
        )
    }
}

async fn seed_pending(c: &Case, count: u32, recorded: i64) {
    let mut tx = c.store.pool.begin().await.unwrap();
    for n in 0..count {
        let event = pending(n);
        let json = crate::tracker::retention::minimized(&event).unwrap();
        sqlx::query("INSERT INTO tracker_unresolved_events(owner_id,conversation_id,message_ref,event_digest,event_json,source_revision,state,reason,recorded_ms) VALUES(?,?,?,?,?,0,'pending','missing_known_thread',?)")
            .bind(c.owner.to_string()).bind(c.conversation.to_string()).bind(event.message_ref.as_deref())
            .bind(crate::digest(&json)).bind(json).bind(recorded).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn pending_capacity_evicts_with_audit_and_advances_scan_cursor() {
    let c = Case::new().await;
    enabled(&c).await;
    seed_pending(&c, 1000, now_ms()).await;
    let event = pending(1001);
    let scanned = ScannedMessage {
        message_ref: event.message_ref.clone().unwrap(),
        outcome: Ok(vec![event]),
    };
    let result = c
        .store
        .record_tracker_scan(
            owner(&c),
            &c.conversation,
            0,
            &[scanned],
            "{\"next\":2}",
            "{}",
        )
        .await
        .unwrap();
    assert_eq!(result.changes[0].kind, TrackerChangeKind::BacklogFull);
    let page = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap();
    assert_eq!(
        (
            page.backlog.pending,
            page.backlog.evicted,
            page.backlog.full
        ),
        (1000, 1, true)
    );
    assert_eq!(
        c.store
            .tracker_config(owner(&c), &c.conversation)
            .await
            .unwrap()
            .cursor_json
            .as_deref(),
        Some("{\"next\":2}")
    );
    let rows = sqlx::query("SELECT event_json,reason,state FROM tracker_unresolved_events")
        .fetch_all(&c.store.pool)
        .await
        .unwrap();
    assert!(rows.iter().all(|r| !r
        .get::<String, _>("event_json")
        .contains("SYNTHETIC_PRIVATE_BODY_SENTINEL")
        && r.get::<String, _>("reason") == "missing_known_thread"));
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='evicted'")
            .await,
        1
    );
    assert!(sqlx::query("DELETE FROM tracker_intake_audit")
        .execute(&c.store.pool)
        .await
        .is_err());
    c.finish().await;
}

#[tokio::test]
async fn stale_pending_expires_with_durable_reason() {
    let c = Case::new().await;
    enabled(&c).await;
    seed_pending(&c, 1, 1).await;
    c.store
        .record_tracker_scan(owner(&c), &c.conversation, 0, &[], "{}", "{}")
        .await
        .unwrap();
    let backlog = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap()
        .backlog;
    assert_eq!((backlog.pending, backlog.expired), (0, 1));
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_unresolved_events WHERE state='expired'")
            .await,
        1
    );
    c.finish().await;
}

#[tokio::test]
async fn row_capacity_records_overflow_without_stalling_cursor() {
    let c = Case::new().await;
    enabled(&c).await;
    c.store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "seed",
                vec![event(
                    TrackerEventKind::Applied,
                    "Seed",
                    Some("Engineer"),
                    1000,
                )],
            ),
        )
        .await
        .unwrap();
    sqlx::query("WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<4999) INSERT INTO tracker_rows SELECT '00000000-0000-4000-8000-'||printf('%012d',v),owner_id,conversation_id,company,company_key,role,role_key,source,status,status_changed_ms,applied_ms,last_contact_ms,next_step,link,location,notes,confidence,needs_review,archived,events_count,revision,created_ms,updated_ms FROM tracker_rows CROSS JOIN n WHERE company='Seed'")
        .execute(&c.store.pool).await.unwrap();
    let event = TrackerEventInput {
        message_ref: Some("eeeeeeeeeeeeeeeeeeeeeeee".into()),
        evidence: Some("SYNTHETIC_OVERFLOW_MAIL_BODY".into()),
        ..event(
            TrackerEventKind::Applied,
            "New company",
            Some("New role"),
            2000,
        )
    };
    let scan = ScannedMessage {
        message_ref: event.message_ref.clone().unwrap(),
        outcome: Ok(vec![event]),
    };
    let result = c
        .store
        .record_tracker_scan(
            owner(&c),
            &c.conversation,
            0,
            std::slice::from_ref(&scan),
            "{\"next\":3}",
            "{}",
        )
        .await
        .unwrap();
    assert_eq!(result.changes[0].kind, TrackerChangeKind::BacklogFull);
    let page = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap();
    assert_eq!(
        (page.rows.len(), page.backlog.overflow, page.backlog.full),
        (5000, 1, true)
    );
    assert_eq!(
        c.store
            .tracker_config(owner(&c), &c.conversation)
            .await
            .unwrap()
            .cursor_json
            .as_deref(),
        Some("{\"next\":3}")
    );
    let audit: String =
        sqlx::query_scalar("SELECT event_json FROM tracker_intake_audit WHERE reason='row_limit'")
            .fetch_one(&c.store.pool)
            .await
            .unwrap();
    assert!(!audit.contains("SYNTHETIC_OVERFLOW_MAIL_BODY"));
    assert!(audit.contains("New company"));
    let replay = c
        .store
        .record_tracker_scan(owner(&c), &c.conversation, 0, &[scan], "{}", "{}")
        .await
        .unwrap();
    assert_eq!((replay.duplicates, replay.changes.len()), (1, 0));
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_ledger WHERE outcome='overflow_row_limit'")
            .await,
        1
    );
    // Overflow audit failure must roll back the cursor and the new ledger key.
    sqlx::query("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON tracker_intake_audit BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END").execute(&c.store.pool).await.unwrap();
    let failed_event = TrackerEventInput {
        message_ref: Some("dddddddddddddddddddddddd".into()),
        ..super::event(
            TrackerEventKind::Applied,
            "Another company",
            Some("Engineer"),
            3000,
        )
    };
    let failed_scan = ScannedMessage {
        message_ref: failed_event.message_ref.clone().unwrap(),
        outcome: Ok(vec![failed_event]),
    };
    assert!(c
        .store
        .record_tracker_scan(
            owner(&c),
            &c.conversation,
            0,
            &[failed_scan],
            "{\"next\":4}",
            "{}"
        )
        .await
        .is_err());
    assert_eq!(
        c.store
            .tracker_config(owner(&c), &c.conversation)
            .await
            .unwrap()
            .cursor_json
            .as_deref(),
        Some("{}")
    );
    assert_eq!(
        c.count("SELECT count(*) FROM tracker_ledger WHERE message_ref='dddddddddddddddddddddddd'")
            .await,
        0
    );
    c.finish().await;
}
