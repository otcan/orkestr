use orkestr_v2_contracts::{V1WorkerState, V1WorkersPage};
use orkestr_v2_ui::v1_workers::{link, notice, retired_toggle, shown, state_label, visible};

fn page() -> V1WorkersPage {
    serde_json::from_value(serde_json::json!({"schema_version": 1, "observed_at_ms": 1000,
        "conversation_id": "00000000-0000-4000-8000-000000000001", "v1_thread_id": "synthetic-group",
        "v1_status": "ready", "retired": 1, "truncated": false, "workers": [
        {"thread_id": "worker-synthetic-group-1", "name": "Synthetic worker 1", "parent_thread_id": "synthetic-group",
         "depth": 1, "state": "working", "last_activity_ms": 900, "preview": {"author": "assistant", "text": "Synthetic progress"},
         "openable": true, "conversation_id": null},
        {"thread_id": "worker-synthetic-group-2", "name": "Synthetic worker 2", "parent_thread_id": "worker-synthetic-group-1",
         "depth": 2, "state": "idle", "last_activity_ms": null, "preview": null,
         "openable": false, "conversation_id": "00000000-0000-4000-8000-000000000002"},
        {"thread_id": "worker-synthetic-group-3", "name": "Synthetic worker 3", "parent_thread_id": "synthetic-group",
         "depth": 1, "state": "retired", "last_activity_ms": 10, "preview": null,
         "openable": false, "conversation_id": null}]})).unwrap()
}

#[test]
fn retired_workers_are_hidden_until_asked_for() {
    let page = page();
    assert!(page.is_valid() && shown(&page));
    let ids = |show| {
        visible(&page, show)
            .iter()
            .map(|w| w.thread_id.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(false),
        ["worker-synthetic-group-1", "worker-synthetic-group-2"]
    );
    assert_eq!(ids(true).len(), 3);
    assert_eq!(
        retired_toggle(&page, false).as_deref(),
        Some("Show retired (1)")
    );
    assert_eq!(
        retired_toggle(&page, true).as_deref(),
        Some("Hide retired (1)")
    );
    assert_eq!(state_label(V1WorkerState::Working), "working");
    assert_eq!(notice(&page, false), None);
}

#[test]
fn links_open_the_v1_entry_or_the_imported_conversation() {
    let page = page();
    assert_eq!(
        link(&page.workers[0]).as_deref(),
        Some("#v1/worker-synthetic-group-1")
    );
    assert_eq!(
        link(&page.workers[1]).as_deref(),
        Some("#conversation/00000000-0000-4000-8000-000000000002")
    );
    assert_eq!(link(&page.workers[2]), None);
}

#[test]
fn empty_unlinked_and_unavailable_pages() {
    let mut page = page();
    page.workers.retain(|w| w.state == V1WorkerState::Retired);
    assert_eq!(notice(&page, false), Some("No V1 workers"));
    assert_eq!(notice(&page, true), None);
    page.retired = 0;
    page.workers.clear();
    assert_eq!(retired_toggle(&page, false), None);
    page.v1_status = orkestr_v2_contracts::SidebarV1Status::Unavailable;
    assert!(notice(&page, false).unwrap().contains("not reachable"));
    page.v1_thread_id = None;
    assert!(!shown(&page));
}
