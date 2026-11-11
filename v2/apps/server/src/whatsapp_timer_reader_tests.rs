use super::*;

fn timers(reader: Option<&str>) -> AgentTimers {
    let mut value = json!({
        "grant_dir": "/srv/core-agent-grants",
        "tool": "/opt/agent_timer.py",
        "v2_url": "http://127.0.0.1:19822",
    });
    if let Some(reader) = reader {
        value["native_grant_dir"] = json!(reader);
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn native_reader_changes_rules_without_changing_core_grant_storage() {
    let legacy = timers(None);
    assert!(legacy.valid());
    assert!(timer_rules("synthetic", &legacy)
        .contains("ORKESTR_V2_AGENT_TIMER_GRANT_DIR=/srv/core-agent-grants \\\n"));
    let split = timers(Some("/srv/provider/agent-timer-grants"));
    assert!(split.valid());
    let rules = timer_rules("synthetic", &split);
    assert!(
        rules.contains("ORKESTR_V2_AGENT_TIMER_GRANT_DIR=/srv/provider/agent-timer-grants \\\n")
    );
    assert!(!rules.contains("/srv/core-agent-grants"));
    assert_eq!(split.grant_dir, "/srv/core-agent-grants");
}

#[test]
fn native_reader_has_the_same_closed_shell_path_boundary() {
    for bad in [
        "relative",
        "/srv/a b",
        "/srv/$(id)",
        "/srv/../etc",
        "/srv/a\"b",
    ] {
        assert!(!timers(Some(bad)).valid(), "{bad}");
    }
}

#[test]
fn a_missing_grant_is_reported_plainly_without_a_repair_request() {
    let rules = timer_rules("synthetic", &timers(None));
    assert!(rules.contains("`grant_file_missing`"));
    assert!(rules.contains("Do not file a\nrepair or Root request"));
}
