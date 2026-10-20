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

pub fn controller_notice(state: &str, armed: bool, hold: Option<&str>) -> &'static str {
    if state != "enabled" {
        "This timer is not enabled to schedule new work. Already admitted work has its own status."
    } else if !armed {
        match hold {
            Some("scheduler_unavailable") => "Your scheduling permission is saved, but the scheduler is unavailable. Work will not be scheduled until it is available.",
            Some("durable_owner_enable_required") => "Scheduling needs your permission. Disable this timer, then enable it with fresh instructions. Retrying an earlier request cannot restore permission.",
            Some("explicit_owner_rearm_required") =>
        "This timer is enabled but not armed. Disable it first, then enable with fresh instructions to allow scheduling after a restart or permission expiry. Retrying an earlier request cannot rearm it.",
            _ => "Scheduling is unavailable. Refresh to check its current status.",
        }
    } else {
        "Scheduling is available. This does not confirm that work has started or completed."
    }
}

/// Format server-provided milliseconds only; never calculate eligibility or due claims.
pub fn utc_time(ms: i64) -> String {
    if !(1..=253402300799999).contains(&ms) {
        return "Scheduled time unavailable".into();
    }
    let seconds = ms / 1000;
    let days = seconds / 86400;
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}
pub fn schedule_label(schedule: &crate::timers::Schedule) -> String {
    use crate::timers::Schedule;
    match schedule {
        Schedule::Once { due_ms } => format!("Once: {}", utc_time(*due_ms)),
        Schedule::Interval { every_ms } if every_ms % 3600000 == 0 => {
            format!("Every {} hours", every_ms / 3600000)
        }
        Schedule::Interval { every_ms } if every_ms % 60000 == 0 => {
            format!("Every {} minutes", every_ms / 60000)
        }
        Schedule::Interval { every_ms } => format!("Every {} milliseconds", every_ms),
        Schedule::UtcClock {
            weekly,
            minute_of_day,
        } => format!(
            "{} at {:02}:{:02} UTC{}",
            if *weekly { "Weekly" } else { "Daily" },
            minute_of_day / 60,
            minute_of_day % 60,
            if *weekly {
                "; weekday not supplied"
            } else {
                ""
            }
        ),
        Schedule::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        } => format!(
            "{} at {:02}:{:02} {}",
            match weekday {
                Some(day) => format!(
                    "Every {}",
                    [
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                        "Sunday"
                    ]
                    .get(usize::from(day.saturating_sub(1)))
                    .copied()
                    .unwrap_or("week")
                ),
                None => "Daily".into(),
            },
            minute_of_day / 60,
            minute_of_day % 60,
            timezone
        ),
        Schedule::Dormant => "Saved schedule needs review".into(),
    }
}
