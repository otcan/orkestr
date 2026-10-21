use orkestr_v2_contracts::*;
use orkestr_v2_ui::sidebar::{activity_label, relative_time, rows, unread_label};
use std::collections::BTreeSet;

fn entry(key: &str, parent: Option<&str>, at: Option<i64>, unread: u32) -> SidebarEntry {
    let v1 = key.strip_prefix("v1:").map(str::to_owned);
    SidebarEntry {
        key: key.into(),
        source: if v1.is_some() {
            SidebarSource::V1
        } else {
            SidebarSource::V2
        },
        name: format!("Synthetic {key}"),
        conversation_id: key
            .strip_prefix("v2:")
            .map(|id| ConversationId(id.parse().unwrap())),
        v1_thread_id: v1.clone(),
        parent_key: parent.map(str::to_owned),
        last_activity_ms: at,
        preview: None,
        unread,
        activity: SidebarActivity::default(),
        read_only: v1.is_some(),
        coordinator: false,
        read_marker: 0,
    }
}

const A: &str = "v2:00000000-0000-4000-8000-00000000000a";

#[test]
fn parents_take_the_newest_child_activity_and_collapse_by_default() {
    let mut busy = entry("v1:worker-parent-2", Some("v1:parent"), Some(900), 3);
    busy.activity.deep = true;
    let entries = vec![
        entry(A, None, Some(500), 0),
        entry("v1:parent", None, Some(100), 0),
        entry("v1:worker-parent-1", Some("v1:parent"), Some(200), 0),
        busy,
        entry("v1:solo", None, None, 0),
    ];
    let collapsed = rows(&entries, &BTreeSet::new(), "");
    let keys: Vec<&str> = collapsed.iter().map(|r| r.entry.key.as_str()).collect();
    assert_eq!(keys, vec!["v1:parent", A, "v1:solo"]);
    let parent = &collapsed[0];
    assert_eq!(
        (
            parent.descendants,
            parent.group_activity_ms,
            parent.hidden_unread
        ),
        (2, Some(900), 3)
    );
    assert!(parent.hidden_activity && !parent.expanded);

    let open = rows(&entries, &BTreeSet::from(["v1:parent".to_string()]), "");
    let keys: Vec<(&str, usize)> = open
        .iter()
        .map(|r| (r.entry.key.as_str(), r.depth))
        .collect();
    assert_eq!(
        keys,
        vec![
            ("v1:parent", 0),
            ("v1:worker-parent-2", 1),
            ("v1:worker-parent-1", 1),
            (A, 0),
            ("v1:solo", 0)
        ]
    );
    assert_eq!(open[0].hidden_unread, 0);
    // Selecting a sub-chat opens its group.
    let selected = rows(&entries, &BTreeSet::new(), "v1:worker-parent-1");
    assert!(selected[0].expanded);
    assert_eq!(selected.len(), 5);
}

#[test]
fn missing_and_cyclic_parents_become_top_level() {
    let entries = vec![
        entry("v1:a", Some("v1:b"), Some(1), 0),
        entry("v1:b", Some("v1:a"), Some(2), 0),
        entry("v1:c", Some("v1:gone"), Some(3), 0),
    ];
    let list = rows(&entries, &BTreeSet::new(), "");
    assert_eq!(list.len(), 3);
    assert!(list.iter().all(|r| r.depth == 0));
}

#[test]
fn labels_for_time_activity_and_unread() {
    let now = 1_760_000_000_000; // 2025-10-09
    assert_eq!(relative_time(now, Some(now - 5_000)), "now");
    assert_eq!(relative_time(now, Some(now - 5 * 60_000)), "5m");
    assert_eq!(relative_time(now, Some(now - 3 * 3_600_000)), "3h");
    assert_eq!(relative_time(now, Some(now - 2 * 86_400_000)), "2d");
    assert_eq!(relative_time(now, Some(now - 30 * 86_400_000)), "9 Sep");
    assert_eq!(relative_time(now, Some(1_700_000_000_000)), "14 Nov 2023");
    assert_eq!(relative_time(now, None), "");
    assert_eq!(relative_time(now, Some(now + 60_000)), "now");
    let mut activity = SidebarActivity::default();
    assert_eq!(activity_label(&activity), None);
    activity.workers = 2;
    assert_eq!(activity_label(&activity).unwrap(), "2 workers thinking…");
    activity.deep = true;
    assert_eq!(activity_label(&activity).unwrap(), "thinking… · 2 workers");
    activity.fast = true;
    assert_eq!(activity_label(&activity).unwrap(), "typing…");
    assert_eq!(unread_label(0), None);
    assert_eq!(unread_label(7).unwrap(), "7");
    assert_eq!(unread_label(140).unwrap(), "99+");
}
