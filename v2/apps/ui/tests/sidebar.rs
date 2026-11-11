use orkestr_v2_contracts::*;
use orkestr_v2_ui::conversation_status::{RowStatus, Tone};
use orkestr_v2_ui::sidebar::{
    activity_label, channel, relative_time, rows, shown, unread_label, work_state, ChannelKind,
    Row, WorkState,
};
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
        whatsapp: None,
        hidden: false,
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

#[test]
fn hidden_system_chats_are_left_out_unless_shown_or_open() {
    let mut probe = entry("v1:probe", None, Some(30), 1);
    probe.hidden = true;
    let mut probe_worker = entry("v1:probe-worker", Some("v1:probe"), Some(40), 0);
    probe_worker.hidden = true;
    let real = entry("v1:real", None, Some(10), 0);
    let all = vec![probe.clone(), probe_worker.clone(), real.clone()];
    let keys = |list: Vec<SidebarEntry>| list.into_iter().map(|e| e.key).collect::<Vec<_>>();
    assert_eq!(keys(shown(&all, false, "v1:real")), vec!["v1:real"]);
    // The open chat stays listed even when hidden (opened by its URL).
    assert_eq!(
        keys(shown(&all, false, "v1:probe")),
        vec!["v1:probe", "v1:real"]
    );
    assert_eq!(
        keys(shown(&all, true, "v1:real")),
        vec!["v1:probe", "v1:probe-worker", "v1:real"]
    );
    // Hidden chats never add to the visible parents' unread or grouping.
    let visible = shown(&all, false, "");
    let grouped = rows(&visible, &BTreeSet::new(), "");
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0].hidden_unread, 0);
}

fn row(entry: SidebarEntry) -> Row {
    Row {
        entry,
        depth: 0,
        descendants: 0,
        group_activity_ms: None,
        hidden_unread: 0,
        hidden_activity: false,
        expanded: false,
    }
}

fn status(label: &str, tone: Tone) -> RowStatus {
    RowStatus {
        label: label.into(),
        tone,
    }
}

#[test]
fn a_row_shows_at_most_one_work_state_and_the_owner_need_comes_first() {
    let idle = row(entry(A, None, Some(1), 0));
    assert_eq!(work_state(&idle, None), None, "idle rows show nothing");
    let mut busy = row(entry(A, None, Some(1), 0));
    busy.entry.activity.deep = true;
    busy.entry.activity.workers = 1;
    // Live activity says more than the run phase it duplicates.
    assert_eq!(
        work_state(&busy, Some(&status("Working", Tone::Working))),
        Some(WorkState {
            label: "thinking… · 1 worker".into(),
            tone: Tone::Working
        })
    );
    // A ready reply or a failure needs the owner: it wins over activity.
    for label in ["Reply ready", "Needs attention", "Failed"] {
        assert_eq!(
            work_state(&busy, Some(&status(label, Tone::Attention))),
            Some(WorkState {
                label: label.into(),
                tone: Tone::Attention
            })
        );
    }
    assert_eq!(
        work_state(&idle, Some(&status("Queued #2", Tone::Queued))),
        Some(WorkState {
            label: "Queued #2".into(),
            tone: Tone::Queued
        })
    );
    let mut parent = row(entry("v1:parent", None, Some(1), 0));
    parent.hidden_activity = true;
    assert_eq!(
        work_state(&parent, None).map(|s| s.label),
        Some("sub-chat thinking…".into())
    );
}

#[test]
fn the_channel_is_one_small_icon_with_the_badge_text_as_its_label() {
    assert_eq!(
        channel(&entry(A, None, None, 0)),
        None,
        "native chats need no icon"
    );
    let mut group = entry("v1:group", None, None, 0);
    group.coordinator = true;
    let v1 = channel(&group).unwrap();
    assert_eq!(v1.kind, ChannelKind::V1);
    assert_eq!(v1.label, "On V1 · coordinator attached");
    let mut whatsapp = entry(A, None, None, 0);
    whatsapp.whatsapp = Some("Synthetic family".into());
    let wa = channel(&whatsapp).unwrap();
    assert_eq!(wa.kind, ChannelKind::WhatsApp);
    assert_eq!(wa.label, "WhatsApp group: Synthetic family");
    whatsapp.whatsapp = Some(whatsapp.name.clone());
    assert_eq!(channel(&whatsapp).unwrap().label, "WhatsApp group");
    group.whatsapp = Some("Synthetic group chat".into());
    let both = channel(&group).unwrap();
    assert_eq!(both.kind, ChannelKind::WhatsApp);
    assert_eq!(
        both.label,
        "WhatsApp group: Synthetic group chat · on V1 · coordinator attached"
    );
}
