use super::*;

#[test]
fn keys_drop_legal_forms_markers_and_punctuation() {
    assert_eq!(tracker_company_key("Acme Robotics GmbH"), "acme-robotics");
    assert_eq!(tracker_company_key("  ACME   Robotics, gmbh. "), "acme-robotics");
    assert_eq!(tracker_company_key("Example AG"), "example");
    assert_eq!(tracker_company_key("Bluebird Logistik GmbH & Co. KG"), "bluebird-logistik");
    assert_eq!(tracker_role_key("DevOps Engineer (m/w/d)"), "devops-engineer");
    assert_eq!(tracker_role_key("Senior Frontend Developer (R-10442)"), "senior-frontend-developer");
    assert_eq!(tracker_role_key("Backend Engineer – Rust"), "backend-engineer-rust");
    assert_eq!(tracker_role_key("Data Engineer (all genders)"), "data-engineer");
}

#[test]
fn canonical_urls_strip_tracking_and_unify_linkedin() {
    assert_eq!(
        tracker_canonical_url("https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&refId=xyz").as_deref(),
        Some("https://linkedin.com/jobs/view/4012345678")
    );
    assert_eq!(
        tracker_canonical_url("https://de.linkedin.com/jobs/view/backend-engineer-at-acme-4012345678?trk=public").as_deref(),
        Some("https://linkedin.com/jobs/view/4012345678")
    );
    assert_eq!(
        tracker_canonical_url("HTTPS://Job-Boards.Greenhouse.io/northwind/jobs/7712345/?utm_source=x&gh_jid=7712345#apply").as_deref(),
        Some("https://job-boards.greenhouse.io/northwind/jobs/7712345?gh_jid=7712345")
    );
    assert_eq!(tracker_canonical_url("mailto:jobs@example.com"), None);
    assert_eq!(tracker_canonical_url("javascript:alert(1)"), None);
    assert_eq!(
        tracker_linkedin_job_id("https://www.linkedin.com/jobs/view/4011111111/").as_deref(),
        Some("4011111111")
    );
    assert_eq!(tracker_linkedin_job_id("https://jobs.lever.co/proseware/5f2c"), None);
}

#[test]
fn transitions_are_monotonic_with_terminal_override_and_review() {
    use TrackerEventKind as E;
    use TrackerStatus as S;
    assert_eq!(tracker_transition(S::Applied, E::InterviewInvite), (S::Interview, false));
    assert_eq!(tracker_transition(S::Interview, E::Viewed), (S::Interview, false));
    assert_eq!(tracker_transition(S::Interview, E::Rejection), (S::Rejected, false));
    assert_eq!(tracker_transition(S::Rejected, E::Offer), (S::Rejected, true));
    assert_eq!(tracker_transition(S::NoResponse, E::Viewed), (S::InReview, false));
    assert_eq!(tracker_transition(S::NoResponse, E::Applied), (S::Applied, false));
    assert_eq!(tracker_transition(S::Saved, E::JobAlert), (S::Saved, false));
    assert_eq!(tracker_transition(S::Offer, E::Note), (S::Offer, false));
}

#[test]
fn vocabulary_roundtrips_and_inputs_are_bounded() {
    for kind in TrackerEventKind::ALL {
        assert_eq!(TrackerEventKind::parse(kind.as_str()), Some(kind));
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, format!("\"{}\"", kind.as_str()));
    }
    for status in TrackerStatus::ALL {
        assert_eq!(TrackerStatus::parse(status.as_str()), Some(status));
    }
    let mut input = TrackerEventInput {
        kind: TrackerEventKind::Applied,
        company: "Acme Robotics GmbH".into(),
        role: Some("Backend Engineer".into()),
        location: None,
        source: "linkedin".into(),
        link: Some("https://www.linkedin.com/jobs/view/4012345678/".into()),
        occurred_ms: 1,
        message_ref: Some("0123456789abcdef01234567".into()),
        sender_domain: Some("linkedin.com".into()),
        evidence: Some("your application was sent".into()),
        classifier: "rule:linkedin.applied".into(),
        confidence: 98,
        next_step: None,
        thread_refs: vec!["abcdefabcdefabcdefabcdef".into()],
        requires_thread: false,
    };
    assert!(input.is_valid());
    input.thread_refs.push("nothex".into());
    assert!(!input.is_valid());
    input.thread_refs.pop();
    input.confidence = 101;
    assert!(!input.is_valid());
    input.confidence = 50;
    input.link = Some("ftp://example.com/x".into());
    assert!(!input.is_valid());
    input.link = None;
    input.company = "  ".into();
    assert!(!input.is_valid());
    let edit = TrackerRowEdit {
        expected_revision: 1,
        link: Some(String::new()),
        ..Default::default()
    };
    assert!(edit.is_valid());
}

#[test]
fn change_lines_are_plain_words() {
    let change = TrackerChange {
        kind: TrackerChangeKind::StatusChanged,
        row_id: None,
        company: "Northwind Labs".into(),
        role: "Platform Engineer".into(),
        event: TrackerEventKind::InterviewInvite,
        from: Some(TrackerStatus::Applied),
        to: Some(TrackerStatus::Interview),
        notify: true,
    };
    assert_eq!(change.line(), "Northwind Labs - Platform Engineer: Applied -> Interview");
    assert!(change.is_news());
    let set = TrackerChangeset { changes: vec![TrackerChange { kind: TrackerChangeKind::Duplicate, ..change }] };
    assert!(!set.has_news());
}

fn row() -> TrackerRow {
    TrackerRow {
        id: Uuid::nil(),
        company: "Acme Robotics GmbH".into(),
        company_key: "acme-robotics".into(),
        role: "Backend Engineer; Rust".into(),
        role_key: "backend-engineer-rust".into(),
        source: "linkedin".into(),
        status: TrackerStatus::Interview,
        status_changed_ms: 1_792_486_800_000,
        applied_ms: Some(1_792_486_800_000),
        last_contact_ms: 1_792_486_800_000,
        next_step: Some("=HYPERLINK(\"x\")".into()),
        link: Some("https://linkedin.com/jobs/view/4012345678".into()),
        location: None,
        notes: "line one\nsaid \"hi\"".into(),
        confidence: 98,
        needs_review: false,
        archived: false,
        events_count: 2,
        revision: 3,
    }
}

#[test]
fn csv_has_bom_iso_dates_quoting_and_no_formulas() {
    assert_eq!(tracker_iso_utc(1_792_486_800_000), "2026-10-20T09:00:00Z");
    assert_eq!(tracker_iso_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(tracker_iso_utc(951_782_400_000), "2000-02-29T00:00:00Z");
    let csv = tracker_csv(&[row()], ',');
    assert!(csv.starts_with("\u{feff}company,role,status,"));
    let line = csv.lines().nth(1).unwrap();
    assert!(line.starts_with("Acme Robotics GmbH,Backend Engineer; Rust,interview,linkedin,2026-10-20,2026-10-20T09:00:00Z,\"'=HYPERLINK(\"\"x\"\")\","));
    assert!(csv.contains("\"line one\nsaid \"\"hi\"\"\""));
    let semi = tracker_csv(&[row()], ';');
    assert!(semi.contains(";\"Backend Engineer; Rust\";"));
    assert!(semi.trim_end().ends_with(";false;false;2"));
}
