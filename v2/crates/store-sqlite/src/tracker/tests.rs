use super::*;
use crate::conversation_resources::tests_settings::Case;

fn event(kind: TrackerEventKind, company: &str, role: Option<&str>, at: i64) -> TrackerEventInput {
    TrackerEventInput {
        kind,
        company: company.into(),
        role: role.map(Into::into),
        location: None,
        source: "linkedin".into(),
        link: None,
        occurred_ms: at,
        message_ref: None,
        sender_domain: None,
        evidence: None,
        classifier: "rule:test".into(),
        confidence: 95,
        next_step: None,
        thread_refs: Vec::new(),
        requires_thread: false,
    }
}

fn batch(key: &str, events: Vec<TrackerEventInput>) -> TrackerEventsRequest {
    TrackerEventsRequest {
        request_key: key.into(),
        events,
    }
}

async fn enabled(case: &Case) {
    case.store
        .enable_tracker(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: default_notify_on(),
            },
        )
        .await
        .unwrap();
}

fn owner(case: &Case) -> TrackerCaller<'_> {
    TrackerCaller::Owner {
        credential: &case.token,
        owner: &case.owner,
    }
}

#[tokio::test]
async fn alert_and_recruiter_mail_for_one_job_become_one_row() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    assert_eq!(
        case.store
            .tracker_page(owner(&case), &chat)
            .await
            .map(|_| ()),
        Err(ResourceError::Conflict("tracker_not_enabled"))
    );
    enabled(&case).await;
    let mut alert = event(
        TrackerEventKind::JobAlert,
        "Tailspin Toys",
        Some("Rust Developer"),
        1_000,
    );
    alert.link = Some("https://www.linkedin.com/comm/jobs/view/4019999991/?trk=eml".into());
    alert.message_ref = Some("aaaaaaaaaaaaaaaaaaaaaaaa".into());
    let first = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("b1", vec![alert]))
        .await
        .unwrap();
    assert_eq!(first.changes[0].kind, TrackerChangeKind::Created);
    assert!(!first.has_news(), "a lead from an alert is quiet");
    // Same job by link (LinkedIn Easy Apply confirmation, other wording).
    let mut applied = event(
        TrackerEventKind::Applied,
        "Tailspin Toys GmbH",
        Some("Rust Developer (m/w/d)"),
        2_000,
    );
    applied.link =
        Some("https://de.linkedin.com/jobs/view/rust-developer-at-tailspin-4019999991".into());
    // Same job by company + role (recruiter mail without a link).
    let mut recruiter = event(
        TrackerEventKind::RecruiterContact,
        "Tailspin Toys",
        Some("Rust developer"),
        3_000,
    );
    recruiter.source = "recruiter".into();
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("b2", vec![applied, recruiter]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].kind, TrackerChangeKind::StatusChanged);
    assert_eq!(set.changes[1].kind, TrackerChangeKind::StatusChanged);
    let page = case.store.tracker_page(owner(&case), &chat).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    let row = &page.rows[0];
    assert_eq!(row.status, TrackerStatus::InReview);
    assert_eq!(row.events_count, 3);
    assert_eq!(row.applied_ms, Some(2_000));
    assert_eq!(row.last_contact_ms, 3_000);
    assert_eq!(
        row.link.as_deref(),
        Some("https://linkedin.com/jobs/view/4019999991")
    );
    let timeline = case
        .store
        .tracker_row_events(owner(&case), &chat, row.id)
        .await
        .unwrap();
    assert_eq!(
        timeline.iter().map(|e| e.kind).collect::<Vec<_>>(),
        [
            TrackerEventKind::JobAlert,
            TrackerEventKind::Applied,
            TrackerEventKind::RecruiterContact
        ]
    );
}

#[tokio::test]
async fn role_less_rejection_ledger_replays_and_terminal_rules() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    enabled(&case).await;
    let mut applied = event(
        TrackerEventKind::ApplicationReceived,
        "Proseware",
        Some("Site Reliability Engineer"),
        1_000,
    );
    applied.message_ref = Some("bbbbbbbbbbbbbbbbbbbbbbbb".into());
    let mut interview = event(
        TrackerEventKind::InterviewInvite,
        "Proseware Inc.",
        None,
        2_000,
    );
    interview.message_ref = Some("cccccccccccccccccccccccc".into());
    let set = case
        .store
        .apply_tracker_events(
            owner(&case),
            &chat,
            &batch("k1", vec![applied.clone(), interview]),
        )
        .await
        .unwrap();
    assert!(set.changes[1].notify, "interview is in the notify set");
    // Replay of the same batch returns the same changes; a different batch
    // under the same key is refused; the same mail again is a duplicate.
    let replay = case
        .store
        .apply_tracker_events(
            owner(&case),
            &chat,
            &batch(
                "k1",
                vec![
                    applied.clone(),
                    event(
                        TrackerEventKind::InterviewInvite,
                        "Proseware Inc.",
                        None,
                        2_000,
                    ),
                ],
            ),
        )
        .await;
    assert_eq!(
        replay,
        Err(ResourceError::Conflict("tracker_batch_conflict"))
    );
    let dup = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("k2", vec![applied]))
        .await
        .unwrap();
    assert_eq!(dup.changes[0].kind, TrackerChangeKind::Duplicate);
    assert!(!dup.has_news());
    // An older rejection never closes a row that moved on since.
    let old_rejection = event(TrackerEventKind::Rejection, "Proseware", None, 1_500);
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("k3", vec![old_rejection]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].kind, TrackerChangeKind::NeedsReview);
    // A newer one does, and a later positive event asks for review.
    let rejection = event(TrackerEventKind::Rejection, "Proseware", None, 3_000);
    let offer = event(
        TrackerEventKind::Offer,
        "Proseware",
        Some("Site Reliability Engineer"),
        4_000,
    );
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("k4", vec![rejection, offer]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].to, Some(TrackerStatus::Rejected));
    assert_eq!(set.changes[1].to, Some(TrackerStatus::Rejected));
    let page = case.store.tracker_page(owner(&case), &chat).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    assert!(page.rows[0].needs_review);
}

#[tokio::test]
async fn ambiguous_company_mail_attaches_to_the_latest_and_asks_for_review() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    enabled(&case).await;
    let a = event(
        TrackerEventKind::Applied,
        "Litware",
        Some("Software Engineer"),
        1_000,
    );
    let b = event(
        TrackerEventKind::Applied,
        "Litware",
        Some("Data Engineer"),
        2_000,
    );
    let unknown = TrackerEventInput {
        confidence: 50,
        ..event(TrackerEventKind::Viewed, "Unknown company", None, 2_500)
    };
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("a", vec![a, b, unknown]))
        .await
        .unwrap();
    assert_eq!(
        set.changes
            .iter()
            .filter(|c| c.kind == TrackerChangeKind::Created)
            .count(),
        3
    );
    let vague = event(TrackerEventKind::Rejection, "Litware", None, 3_000);
    let set = case
        .store
        .apply_tracker_events(owner(&case), &chat, &batch("b", vec![vague]))
        .await
        .unwrap();
    assert_eq!(set.changes[0].role, "Data Engineer");
    let page = case.store.tracker_page(owner(&case), &chat).await.unwrap();
    assert_eq!(page.rows.len(), 3);
    assert!(
        page.rows
            .iter()
            .find(|r| r.role == "Data Engineer")
            .unwrap()
            .needs_review
    );
    assert!(
        page.rows
            .iter()
            .find(|r| r.company == "Unknown company")
            .unwrap()
            .needs_review
    );
}

#[tokio::test]
async fn manual_edit_merge_grant_and_validation() {
    let case = Case::new().await;
    let chat = case.conversation.clone();
    enabled(&case).await;
    let rows = vec![
        event(
            TrackerEventKind::Applied,
            "Fabrikam AG",
            Some("Senior Frontend Developer (R-10442)"),
            1_000,
        ),
        event(
            TrackerEventKind::Saved,
            "Fabrikam",
            Some("Frontend Lead"),
            1_500,
        ),
    ];
    case.store
        .apply_tracker_events(owner(&case), &chat, &batch("m", rows))
        .await
        .unwrap();
    let page = case.store.tracker_page(owner(&case), &chat).await.unwrap();
    let (lead, app) = (page.rows[0].clone(), page.rows[1].clone());
    // Stale revision, then an accepted manual status edit.
    let edit = TrackerRowEdit {
        expected_revision: 9,
        status: Some(TrackerStatus::Withdrawn),
        ..Default::default()
    };
    assert_eq!(
        case.store
            .edit_tracker_row(&case.token, &case.owner, &chat, app.id, &edit)
            .await,
        Err(ResourceError::Conflict("tracker_row_revision_mismatch"))
    );
    let edit = TrackerRowEdit {
        expected_revision: app.revision,
        status: Some(TrackerStatus::Interview),
        notes: Some("Call on Monday".into()),
        next_step: Some("Prepare system design".into()),
        ..Default::default()
    };
    let edited = case
        .store
        .edit_tracker_row(&case.token, &case.owner, &chat, app.id, &edit)
        .await
        .unwrap();
    assert_eq!(edited.status, TrackerStatus::Interview);
    assert_eq!(edited.next_step.as_deref(), Some("Prepare system design"));
    let timeline = case
        .store
        .tracker_row_events(owner(&case), &chat, app.id)
        .await
        .unwrap();
    assert_eq!(timeline.last().unwrap().classifier, "manual");
    // Merge the lead into the application.
    let merged = case
        .store
        .merge_tracker_rows(
            &case.token,
            &case.owner,
            &chat,
            &TrackerMerge {
                keep: app.id,
                absorb: lead.id,
            },
        )
        .await
        .unwrap();
    assert_eq!(merged.events_count, 4);
    assert_eq!(
        case.store
            .tracker_page(owner(&case), &chat)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    // Grant: reads and writes this tracker only; rotation invalidates.
    let issued = case
        .store
        .issue_tracker_grant(&case.token, &case.owner, &chat)
        .await
        .unwrap();
    let grant = TrackerCaller::Grant(&issued.grant);
    assert!(
        case.store
            .tracker_page(grant, &chat)
            .await
            .unwrap()
            .grant_issued
    );
    let other = case.conversation("other").await;
    assert_eq!(
        case.store.tracker_page(grant, &other).await.map(|_| ()),
        Err(ResourceError::Unauthorized)
    );
    let rotated = case
        .store
        .issue_tracker_grant(&case.token, &case.owner, &chat)
        .await
        .unwrap();
    assert_eq!(
        case.store.tracker_page(grant, &chat).await.map(|_| ()),
        Err(ResourceError::Unauthorized)
    );
    case.store
        .apply_tracker_events(
            TrackerCaller::Grant(&rotated.grant),
            &chat,
            &batch(
                "g",
                vec![TrackerEventInput {
                    source: "direct".into(),
                    classifier: "assistant".into(),
                    ..event(TrackerEventKind::Note, "Fabrikam AG", None, 5_000)
                }],
            ),
        )
        .await
        .unwrap();
    case.store
        .revoke_tracker_grant(&case.token, &case.owner, &chat)
        .await
        .unwrap();
    assert_eq!(
        case.store
            .tracker_page(TrackerCaller::Grant(&rotated.grant), &chat)
            .await
            .map(|_| ()),
        Err(ResourceError::Unauthorized)
    );
    // Validation.
    for bad in [
        batch("", vec![event(TrackerEventKind::Applied, "X", None, 1)]),
        batch("ok", vec![]),
        batch("ok", vec![event(TrackerEventKind::Applied, " ", None, 1)]),
        batch(
            "ok",
            vec![TrackerEventInput {
                confidence: 101,
                ..event(TrackerEventKind::Applied, "X", None, 1)
            }],
        ),
    ] {
        assert_eq!(
            case.store
                .apply_tracker_events(owner(&case), &chat, &bad)
                .await,
            Err(ResourceError::Invalid)
        );
    }
    // Events are append-only.
    assert!(sqlx::query("UPDATE tracker_events SET evidence='changed'")
        .execute(&case.store.pool)
        .await
        .is_err());
}

#[path = "integrity_tests.rs"]
mod integrity;
#[path = "reconsider_tests.rs"]
mod reconsider;
#[path = "scan_tests.rs"]
mod scans;

#[path = "review_annotation_tests.rs"]
mod review_annotations;
#[path = "review_authority_tests.rs"]
mod review_authority;
#[path = "review_history_tests.rs"]
mod review_history;
#[path = "review_intake_tests.rs"]
mod review_intake;
