use orkestr_v2_contracts::{TrackerEventKind, TrackerRow, TrackerStatus};
use orkestr_v2_ui::tracker::{count, day, source_label, visible, Column, Filter, NewRow, Sort};

fn row(n: u128, company: &str, status: TrackerStatus, last: i64) -> TrackerRow {
    serde_json::from_value(serde_json::json!({
        "id": format!("00000000-0000-4000-8000-{n:012}"),
        "company": company, "company_key": company.to_lowercase(),
        "role": format!("Role {n}"), "role_key": format!("role-{n}"),
        "source": "ats:greenhouse", "status": status, "status_changed_ms": last,
        "applied_ms": last - 10, "last_contact_ms": last, "next_step": null, "link": null,
        "location": null, "notes": "", "confidence": 90, "needs_review": false,
        "archived": false, "events_count": 1, "revision": 1
    }))
    .unwrap()
}

#[test]
fn filters_search_and_sort() {
    let mut rows = vec![
        row(1, "Acme", TrackerStatus::Interview, 3_000),
        row(2, "Contoso", TrackerStatus::Rejected, 5_000),
        row(3, "Tailspin", TrackerStatus::Saved, 4_000),
        row(4, "Fabrikam", TrackerStatus::Applied, 1_000),
    ];
    rows[3].needs_review = true;
    rows.push(TrackerRow { archived: true, ..row(5, "Litware", TrackerStatus::Applied, 9_000) });
    let names = |v: Vec<&TrackerRow>| v.into_iter().map(|r| r.company.clone()).collect::<Vec<_>>();
    assert_eq!(names(visible(&rows, Filter::Open, "", Sort::default())), ["Acme", "Fabrikam"]);
    assert_eq!(names(visible(&rows, Filter::Leads, "", Sort::default())), ["Tailspin"]);
    assert_eq!(names(visible(&rows, Filter::Closed, "", Sort::default())), ["Contoso"]);
    assert_eq!(names(visible(&rows, Filter::Review, "", Sort::default())), ["Fabrikam"]);
    assert_eq!(names(visible(&rows, Filter::Archived, "", Sort::default())), ["Litware"]);
    assert_eq!(count(&rows, Filter::All), 4);
    assert_eq!(names(visible(&rows, Filter::All, "conto", Sort::default())), ["Contoso"]);
    let by_company = Sort::default().toggle(Column::Company);
    assert!(!by_company.descending);
    assert_eq!(names(visible(&rows, Filter::All, "", by_company)), ["Acme", "Contoso", "Fabrikam", "Tailspin"]);
    assert_eq!(names(visible(&rows, Filter::All, "", by_company.toggle(Column::Company))), ["Tailspin", "Fabrikam", "Contoso", "Acme"]);
    let by_status = Sort::default().toggle(Column::Status);
    assert_eq!(names(visible(&rows, Filter::All, "", by_status))[0], "Contoso");
}

#[test]
fn labels_and_manual_rows() {
    assert_eq!(day(1_792_486_800_000), "2026-10-20");
    assert_eq!(source_label("ats:greenhouse"), "Greenhouse");
    assert_eq!(source_label("linkedin"), "LinkedIn");
    assert_eq!(NewRow::default().event(1), Err("Enter a company."));
    let new = NewRow { company: " Acme ".into(), role: "".into(), link: "ftp://x".into(), status: Some(TrackerStatus::Interview) };
    assert!(new.event(1).is_err());
    let new = NewRow { link: "https://jobs.lever.co/acme/1".into(), ..new };
    let event = new.event(5).unwrap();
    assert_eq!((event.company.as_str(), event.role, event.kind, event.classifier.as_str()), ("Acme", None, TrackerEventKind::InterviewScheduled, "manual"));
}
