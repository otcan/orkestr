//! Immutable edits and logical merge regression coverage.
use super::*;
#[tokio::test]
async fn absorbed_keys_attach_to_the_surviving_row_without_recreating_a_duplicate() {
    let c = Case::new().await;
    enabled(&c).await;
    let first = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "seed",
                vec![
                    event(
                        TrackerEventKind::Applied,
                        "Example A",
                        Some("Engineer A"),
                        1000,
                    ),
                    event(
                        TrackerEventKind::Applied,
                        "Example B",
                        Some("Engineer B"),
                        2000,
                    ),
                ],
            ),
        )
        .await
        .unwrap();
    let absorb = first.changes[0].row_id.unwrap();
    let keep = first.changes[1].row_id.unwrap();
    c.store
        .merge_tracker_rows(
            &c.token,
            &c.owner,
            &c.conversation,
            &TrackerMerge { keep, absorb },
        )
        .await
        .unwrap();
    let next = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "after-merge",
                vec![event(
                    TrackerEventKind::InterviewInvite,
                    "Example A",
                    Some("Engineer A"),
                    3000,
                )],
            ),
        )
        .await
        .unwrap();
    assert_eq!(next.changes[0].kind, TrackerChangeKind::StatusChanged);
    assert_eq!(next.changes[0].row_id, Some(keep));
    assert_eq!(
        c.store
            .tracker_page(owner(&c), &c.conversation)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_ne!(next.changes[0].row_id, Some(absorb));
    assert_eq!(
        c.count(&format!(
            "SELECT count(*) FROM tracker_events WHERE row_id='{absorb}'"
        ))
        .await,
        1
    );
    c.finish().await;
}

#[tokio::test]
async fn owner_field_edits_and_no_response_have_immutable_minimized_events() {
    let c = Case::new().await;
    enabled(&c).await;
    let seed = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "seed",
                vec![TrackerEventInput {
                    evidence: Some("SYNTHETIC_MAIL_BODY_SENTINEL".into()),
                    ..event(TrackerEventKind::Applied, "Example", Some("Engineer"), 1000)
                }],
            ),
        )
        .await
        .unwrap();
    let id = seed.changes[0].row_id.unwrap();
    let edit = TrackerRowEdit {
        expected_revision: 1,
        company: Some("Renamed example".into()),
        role: Some("New role".into()),
        link: Some("https://jobs.example/position/1".into()),
        notes: Some("SYNTHETIC_OWNER_NOTE_SENTINEL".into()),
        archived: Some(true),
        ..Default::default()
    };
    let row = c
        .store
        .edit_tracker_row(&c.token, &c.owner, &c.conversation, id, &edit)
        .await
        .unwrap();
    let history = c
        .store
        .tracker_row_events(owner(&c), &c.conversation, id)
        .await
        .unwrap();
    assert_eq!(
        history[0].evidence.as_deref(),
        Some(format!("sha256:{}", crate::digest("SYNTHETIC_MAIL_BODY_SENTINEL")).as_str())
    );
    let audit = history
        .iter()
        .find(|e| e.kind == TrackerEventKind::Edited)
        .unwrap();
    let evidence: serde_json::Value =
        serde_json::from_str(audit.evidence.as_deref().unwrap()).unwrap();
    for field in ["company", "role", "link", "notes", "archived"] {
        assert!(evidence["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == field));
    }
    assert!(!audit
        .evidence
        .as_deref()
        .unwrap()
        .contains("SYNTHETIC_OWNER_NOTE_SENTINEL"));
    c.store
        .edit_tracker_row(
            &c.token,
            &c.owner,
            &c.conversation,
            id,
            &TrackerRowEdit {
                expected_revision: row.revision,
                status: Some(TrackerStatus::NoResponse),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let history = c
        .store
        .tracker_row_events(owner(&c), &c.conversation, id)
        .await
        .unwrap();
    assert!(history
        .iter()
        .any(|e| e.kind == TrackerEventKind::NoResponse));
    assert!(
        sqlx::query("UPDATE tracker_events SET evidence='modified' WHERE kind='edited'")
            .execute(&c.store.pool)
            .await
            .is_err()
    );
    assert_eq!(
        c.store
            .tracker_page(owner(&c), &c.conversation)
            .await
            .unwrap()
            .rows[0]
            .events_count as usize,
        history.len()
    );
    c.finish().await;
}

#[tokio::test]
async fn merge_selects_latest_status_event_time_including_lower_progress() {
    use TrackerEventKind as E;
    for (keep_kind, keep_time, absorb_kind, absorb_time, expected, time) in [
        (
            E::Offer,
            3000,
            E::Rejection,
            2000,
            TrackerStatus::Offer,
            3000,
        ),
        (
            E::Withdrawn,
            4000,
            E::Rejection,
            1000,
            TrackerStatus::Withdrawn,
            4000,
        ),
        (
            E::InterviewInvite,
            1000,
            E::Applied,
            2000,
            TrackerStatus::Applied,
            2000,
        ),
        (
            E::Offer,
            1000,
            E::Rejection,
            1000,
            TrackerStatus::Offer,
            1000,
        ),
    ] {
        let c = Case::new().await;
        enabled(&c).await;
        let set = c
            .store
            .apply_tracker_events(
                owner(&c),
                &c.conversation,
                &batch(
                    "seed",
                    vec![
                        event(keep_kind, "Example A", Some("Engineer"), keep_time),
                        event(absorb_kind, "Example B", Some("Engineer"), absorb_time),
                    ],
                ),
            )
            .await
            .unwrap();
        let merged = c
            .store
            .merge_tracker_rows(
                &c.token,
                &c.owner,
                &c.conversation,
                &TrackerMerge {
                    keep: set.changes[0].row_id.unwrap(),
                    absorb: set.changes[1].row_id.unwrap(),
                },
            )
            .await
            .unwrap();
        assert_eq!((merged.status, merged.status_changed_ms), (expected, time));
        assert_eq!(
            merged.next_step,
            expected.default_next_step().map(str::to_owned)
        );
        c.finish().await;
    }
}

#[tokio::test]
async fn exact_and_roleless_aliases_follow_multiple_merges_to_one_survivor() {
    let c = Case::new().await;
    enabled(&c).await;
    let set = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "seed",
                vec![
                    event(TrackerEventKind::Applied, "Example A", Some("Role A"), 1000),
                    event(TrackerEventKind::Applied, "Example B", Some("Role B"), 1000),
                    event(TrackerEventKind::Applied, "Example C", Some("Role C"), 1000),
                ],
            ),
        )
        .await
        .unwrap();
    let ids: Vec<_> = set.changes.iter().map(|c| c.row_id.unwrap()).collect();
    for (keep, absorb) in [(ids[1], ids[0]), (ids[2], ids[1])] {
        c.store
            .merge_tracker_rows(
                &c.token,
                &c.owner,
                &c.conversation,
                &TrackerMerge { keep, absorb },
            )
            .await
            .unwrap();
    }
    let set = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "aliases",
                vec![
                    event(
                        TrackerEventKind::RecruiterContact,
                        "Example A",
                        Some("Role A"),
                        2000,
                    ),
                    event(TrackerEventKind::Viewed, "Example A", None, 2001),
                    event(
                        TrackerEventKind::InReview,
                        "Example B",
                        Some("Role B"),
                        2002,
                    ),
                ],
            ),
        )
        .await
        .unwrap();
    assert!(set
        .changes
        .iter()
        .all(|c| c.row_id == Some(ids[2]) && c.kind != TrackerChangeKind::Created));
    let page = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].events_count, 6);
    assert_eq!(c.count("SELECT count(*) FROM tracker_rows").await, 3);
    c.finish().await;
}
