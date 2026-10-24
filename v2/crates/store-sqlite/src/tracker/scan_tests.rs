//! Scan bookkeeping and authenticated thread matching.
use super::*;

#[tokio::test]
async fn scans_record_events_drops_and_cursor_once() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    enabled(&case).await;
    let source = r#"{"kind":"thunderbird","folders":[],"since_days":60}"#;
    let config = case
        .store
        .set_tracker_source(&case.token, &case.owner, &chat, Some(source))
        .await
        .unwrap();
    assert_eq!(config.source_json.as_deref(), Some(source));
    assert_eq!(
        case.store
            .set_tracker_source(&case.token, &case.owner, &chat, Some("not json"))
            .await,
        Err(ResourceError::Invalid)
    );
    let mut alert_a = event(
        TrackerEventKind::JobAlert,
        "Tailspin Toys",
        Some("Rust Developer"),
        1_000,
    );
    alert_a.message_ref = Some("dddddddddddddddddddddddd".into());
    let mut alert_b = event(
        TrackerEventKind::JobAlert,
        "Wingtip Solutions",
        Some("Systems Engineer"),
        1_000,
    );
    alert_b.message_ref = alert_a.message_ref.clone();
    let mut interview = event(
        TrackerEventKind::InterviewInvite,
        "Northwind Labs",
        Some("Platform Engineer"),
        2_000,
    );
    interview.message_ref = Some("eeeeeeeeeeeeeeeeeeeeeeee".into());
    let messages = vec![
        ScannedMessage {
            message_ref: "dddddddddddddddddddddddd".into(),
            outcome: Ok(vec![alert_a, alert_b]),
        },
        ScannedMessage {
            message_ref: "ffffffffffffffffffffffff".into(),
            outcome: Err("drop:social".into()),
        },
        ScannedMessage {
            message_ref: "eeeeeeeeeeeeeeeeeeeeeeee".into(),
            outcome: Ok(vec![interview]),
        },
    ];
    let first = case
        .store
        .record_tracker_scan(
            owner(&case),
            &chat,
            config.source_revision,
            &messages,
            r#"{"folders":{}}"#,
            "{}",
        )
        .await
        .unwrap();
    assert_eq!(
        (
            first.labelled,
            first.dropped,
            first.duplicates,
            first.changes.len()
        ),
        (2, 1, 0, 3)
    );
    let set = TrackerChangeset {
        changes: first.changes.clone(),
    };
    assert!(
        set.has_news(),
        "the interview is news, the alert leads are not"
    );
    assert!(set.changes.iter().any(|c| c.notify));
    // The same messages again (cursor reset, compaction): nothing recorded.
    let again = case
        .store
        .record_tracker_scan(
            owner(&case),
            &chat,
            config.source_revision,
            &messages,
            "{}",
            "{}",
        )
        .await
        .unwrap();
    assert_eq!((again.duplicates, again.changes.len()), (3, 0));
    let config = case
        .store
        .tracker_config(owner(&case), &chat)
        .await
        .unwrap();
    assert!(config.last_scan_ms.is_some());
    assert_eq!(config.cursor_json.as_deref(), Some("{}"));
    // A new source restarts the cursor.
    let config = case
        .store
        .set_tracker_source(
            &case.token,
            &case.owner,
            &chat,
            Some(r#"{"kind":"thunderbird","folders":["Jobs"]}"#),
        )
        .await
        .unwrap();
    assert_eq!(config.cursor_json, None);
    assert_eq!(
        case.store
            .tracker_page(owner(&case), &chat)
            .await
            .unwrap()
            .rows
            .len(),
        3
    );
}

#[tokio::test]
async fn replies_attach_by_thread_and_untrusted_mail_needs_a_thread() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    enabled(&case).await;
    // The user's own application (Sent folder) to an agency.
    let mut sent = event(
        TrackerEventKind::Applied,
        "Example Agency A",
        Some("Example Java Developer (TEST-A)"),
        1_000,
    );
    sent.source = "agency:example-a".into();
    sent.message_ref = Some("111111111111111111111111".into());
    case.store
        .apply_tracker_events(owner(&case), &chat, &batch("s", vec![sent]))
        .await
        .unwrap();
    // A gated reply in that thread attaches regardless of its company text.
    let mut reply = event(TrackerEventKind::Rejection, "Unknown company", None, 2_000);
    reply.requires_thread = true;
    reply.message_ref = Some("222222222222222222222222".into());
    reply.thread_refs = vec![
        "999999999999999999999999".into(),
        "111111111111111111111111".into(),
    ];
    // A gated "interview" pitch outside any known thread records nothing.
    let mut pitch = event(
        TrackerEventKind::InterviewInvite,
        "Growth Tools",
        None,
        2_500,
    );
    pitch.requires_thread = true;
    pitch.message_ref = Some("333333333333333333333333".into());
    pitch.thread_refs = vec!["888888888888888888888888".into()];
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("r", vec![reply, pitch]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].kind, TrackerChangeKind::StatusChanged);
    assert_eq!(set.changes[0].company, "Example Agency A");
    assert_eq!(set.changes[1].kind, TrackerChangeKind::Unmatched);
    assert!(!TrackerChangeset {
        changes: vec![set.changes[1].clone()]
    }
    .has_news());
    let page = case.store.tracker_page(owner(&case), &chat).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].status, TrackerStatus::Rejected);
    // A second reply to the reply (References chain) still finds the row.
    let mut later = event(
        TrackerEventKind::RecruiterContact,
        "Unknown company",
        None,
        3_000,
    );
    later.requires_thread = true;
    later.thread_refs = vec!["222222222222222222222222".into()];
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("l", vec![later]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].row_id, Some(page.rows[0].id));
}
