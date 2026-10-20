use orkestr_v2_contracts::LiveMap;
use orkestr_v2_ui::live_map::{
    ago, host_status, short_id, unlinked_conversations, view_active, views,
};

const DELEGATED: &str = "00000000-0000-4000-8000-0000000000d1";
const OTHER: &str = "00000000-0000-4000-8000-0000000000d2";

fn map() -> LiveMap {
    serde_json::from_value(serde_json::json!({
        "schema_version": 1, "observed_at_ms": 1_000_000,
        "host": {"status": "ready", "generated_at_ms": 995_000, "modified_at_ms": 995_000, "views": [
            {"view": "whatsapp-group", "name": "Quiet group", "chat_id": "synthetic-1", "thread_id": "thread-1",
             "fast_layer": "V1 thread executor (Codex)", "delegated_to_v2": null,
             "sessions": [{"session_id": "s-idle", "kind": "codex", "role": "attached", "live": false, "last_activity_ms": 10_000, "agents": []}]},
            {"view": "whatsapp-group", "name": "Busy group", "chat_id": "synthetic-2", "thread_id": "thread-2",
             "fast_layer": "V1 thread executor (Codex)", "delegated_to_v2": null,
             "sessions": [
                {"session_id": "s-live", "kind": "claude-code", "role": "attached", "live": true, "last_activity_ms": 990_000, "agents": [
                    {"agent_id": "a1", "name": "running agent", "status": "running", "started_at_ms": 900_000, "last_activity_ms": 999_000},
                    {"agent_id": "a2", "name": "done agent", "status": "finished", "started_at_ms": 800_000, "last_activity_ms": 850_000}]},
                {"session_id": "s-old", "kind": "unknown", "role": "attached", "live": false, "last_activity_ms": null, "agents": []}]},
            {"view": "whatsapp-group", "name": "Delegated group", "chat_id": "synthetic-3", "thread_id": "thread-3",
             "fast_layer": "V1 thread executor (Codex)",
             "delegated_to_v2": {"remote_backend": "v2", "remote_thread_id": DELEGATED, "remote_runtime_enabled": true, "conversation_id": DELEGATED},
             "sessions": []}
        ]},
        "conversations": [
            {"conversation_id": DELEGATED, "name": "Delegated", "partial": false, "fast": null,
             "deep": {"run_id": "00000000-0000-4000-8000-0000000000e1", "phase": "running", "observed_at_ms": 999_000},
             "window": {"window_id": "00000000-0000-4000-8000-0000000000f1", "generation": 2, "state": "active",
                        "opened_at_ms": 990_000, "work_deadline_ms": 1_800_000, "expires_at_ms": 1_900_000},
             "workers": [{"run_id": "00000000-0000-4000-8000-0000000000e2", "session_id": "00000000-0000-4000-8000-0000000000e3",
                          "parent_run_id": "00000000-0000-4000-8000-0000000000e1", "state": "succeeded", "recovery": "current_incarnation"}]},
            {"conversation_id": OTHER, "name": "Idle native", "partial": false, "fast": null, "deep": null, "window": null, "workers": []}
        ],
        "conversations_truncated": false
    }))
    .unwrap()
}

#[test]
fn active_only_keeps_live_sessions_running_agents_and_delegated_work() {
    let map = map();
    assert!(map.is_valid());
    let rows = views(&map, true);
    let names: Vec<_> = rows
        .iter()
        .map(|r| r.view.name.as_deref().unwrap())
        .collect();
    // Quiet group has no live session; Delegated group is live through its V2 window.
    assert_eq!(names, ["Busy group", "Delegated group"]);
    let busy = &rows[0];
    assert_eq!(busy.sessions.len(), 1);
    assert_eq!(busy.hidden_sessions, 1);
    assert_eq!(busy.sessions[0].agents.len(), 1);
    assert_eq!(busy.sessions[0].agents[0].agent_id, "a1");
    assert_eq!(busy.sessions[0].hidden_agents, 1);
    assert_eq!(
        rows[1].conversation.unwrap().conversation_id.to_string(),
        DELEGATED
    );
    assert!(unlinked_conversations(&map, true).is_empty());
}

#[test]
fn all_shows_everything_with_active_views_first() {
    let map = map();
    let rows = views(&map, false);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2].view.name.as_deref(), Some("Quiet group"));
    assert!(rows.iter().all(|r| r.hidden_sessions == 0));
    assert!(!view_active(&map, rows[2].view));
    let other = unlinked_conversations(&map, false);
    assert_eq!(other.len(), 1);
    assert_eq!(other[0].name, "Idle native");
}

#[test]
fn labels_use_the_server_clock_and_report_host_state() {
    assert_eq!(ago(10_000, Some(5_000)), "5s ago");
    assert_eq!(ago(10_000, Some(20_000)), "0s ago");
    assert_eq!(ago(4_000_000, Some(0)), "1h ago");
    assert_eq!(ago(1, None), "never");
    assert_eq!(short_id("short"), "short");
    assert_eq!(short_id("thread-synthetic-delegated"), "thread-s");
    assert_eq!(short_id("thread-synthetic"), "thread-synthetic");
    assert_eq!(short_id("12345678-0000-4000-8000-0000000000d1"), "12345678");
    let mut map = map();
    assert!(host_status(&map).starts_with("Host map current"));
    map.observed_at_ms += 600_000;
    assert!(host_status(&map).starts_with("Host map stale"));
    map.host.status = orkestr_v2_contracts::HostLiveMapStatus::Missing;
    map.host.views.clear();
    assert_eq!(host_status(&map), "Host map not generated yet");
}
