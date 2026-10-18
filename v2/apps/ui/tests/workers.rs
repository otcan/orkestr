use orkestr_v2_contracts::{runtime::SessionRole, WorkerExecutionPage};
use orkestr_v2_ui::workers::{recovery_label, Workers};
fn page() -> WorkerExecutionPage {
    serde_json::from_value(serde_json::json!({"schema_version":1,
        "conversation_id":"00000000-0000-4000-8000-000000000001","revision":10,"observed_at_ms":1000,
        "workers":[{"run_id":"00000000-0000-4000-8000-000000000010",
        "session_id":"00000000-0000-4000-8000-000000000020",
        "parent_run_id":"00000000-0000-4000-8000-000000000030",
        "parent_session_id":"00000000-0000-4000-8000-000000000040",
        "source_message_id":"00000000-0000-4000-8000-000000000050",
        "source_event_id":"00000000-0000-4000-8000-000000000060",
        "role":"worker","state":"running","control_revision":2,"recovery":"reconciliation_required"}],
        "next_after":null})).unwrap()
}
#[test]
fn exact_worker_locator_and_recovery_do_not_grant_readiness_or_control() {
    let mut workers = Workers::default();
    let page = page();
    let read = workers.begin(page.conversation_id.clone(), None);
    assert!(workers.notice(1).contains("Loading"));
    workers.apply(&read, 1, page.clone()).unwrap();
    assert!(workers.select(&page.workers[0].run_id));
    assert!(recovery_label(page.workers[0].recovery).contains("automatic resume unavailable"));
    let same = workers.begin(page.conversation_id.clone(), None);
    workers.apply(&same, 60001, page.clone()).unwrap();
    assert!(workers.notice(60001).contains("stale"));
    workers.clear_owner();
    assert!(workers.page().is_none());
    assert!(workers.selected().is_none());
    assert!(workers.apply(&read, 60002, page).is_err());
}
#[test]
fn invalid_role_scope_page_order_and_old_generation_preserve_prior_page() {
    let mut workers = Workers::default();
    let page = page();
    let old = workers.begin(page.conversation_id.clone(), None);
    workers.apply(&old, 1, page.clone()).unwrap();
    let read = workers.begin(page.conversation_id.clone(), None);
    assert!(workers.apply(&old, 2, page.clone()).is_err());
    for i in 0..5 {
        let mut bad = page.clone();
        match i {
            0 => bad.workers[0].role = SessionRole::Deep,
            1 => bad.workers.push(bad.workers[0].clone()),
            2 => bad.workers[0].control_revision = 0,
            3 => bad.revision = 9,
            _ => {
                bad.conversation_id = serde_json::from_value(serde_json::json!(
                    "00000000-0000-4000-8000-000000000099"
                ))
                .unwrap()
            }
        }
        assert!(workers.apply(&read, 2, bad).is_err());
        assert_eq!(workers.page(), Some(&page));
    }
    let next = workers.begin(
        page.conversation_id.clone(),
        Some(page.workers[0].run_id.clone()),
    );
    assert!(workers.apply(&next, 2, page.clone()).is_err());
    workers.failed(&old);
    assert!(workers.notice(2).contains("Loading"));
    workers.failed(&next);
    assert!(workers.notice(2).contains("unavailable"));
    assert_eq!(workers.page(), Some(&page));
}
#[test]
fn next_page_replaces_bounded_selection_and_conversation_change_fences_reads() {
    let mut workers = Workers::default();
    let first = page();
    let read = workers.begin(first.conversation_id.clone(), None);
    workers.apply(&read, 10, first.clone()).unwrap();
    assert!(workers.select(&first.workers[0].run_id));
    let next = workers.begin(
        first.conversation_id.clone(),
        Some(first.workers[0].run_id.clone()),
    );
    assert!(
        workers.selected().is_none(),
        "page navigation clears the displayed run before its response"
    );
    assert!(workers.displayed_page().is_none());
    assert!(!workers.select(&first.workers[0].run_id));
    let mut second = first.clone();
    second.workers[0].run_id =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000011")).unwrap();
    second.observed_at_ms += 1;
    workers.apply(&next, 11, second.clone()).unwrap();
    assert_eq!(workers.page(), Some(&second));
    assert!(workers.selected().is_none());
    assert!(!workers.select(&first.workers[0].run_id));
    let other =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000099")).unwrap();
    workers.begin(other, None);
    assert!(workers.page().is_none());
    assert!(workers.apply(&next, 12, second).is_err());
}
