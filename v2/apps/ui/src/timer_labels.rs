//! Human-readable timer evidence. These labels never grant or calculate a due claim.
pub fn held_reason(reason: Option<&str>) -> Option<&'static str> {
    reason.map(|reason| match reason {
        "missing_timezone" => {
            "Held: an explicit timezone is required before this schedule can be enabled."
        }
        "unsupported_timezone" => "Held: this schedule uses a timezone that is not supported yet.",
        "ambiguous_cadence" => {
            "Held: the saved repeat schedule needs clarification before enabling."
        }
        "uncertain_effects" => "Held: review what this timer will do before enabling it.",
        _ => "Held: this schedule needs review before it can run.",
    })
}

pub fn state_label(state: &str) -> &'static str {
    match state {
        "paused" => "Paused",
        "enabled" => "Enabled",
        "disabled" => "Disabled",
        "stopped" => "Stopped",
        "rolled_back" => "Rolled back",
        "exhausted" => "Schedule finished",
        _ => "Timer state unavailable",
    }
}

pub fn controller_notice(state: &str, armed: bool) -> &'static str {
    if state != "enabled" {
        "This timer is not enabled to schedule new work. Already admitted work has its own status."
    } else if !armed {
        "This timer is enabled but not armed. Explicitly enable it again to allow scheduling after a restart."
    } else {
        "Scheduling is armed. This does not confirm that work has started or completed."
    }
}
