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
        Schedule::Calendar { summary, .. } => summary.clone(),
        Schedule::Event => "Runs when something arrives".into(),
        Schedule::Dormant => "Saved schedule needs review".into(),
    }
}

/// What starts the timer besides (or instead of) the clock.
pub fn trigger_label(policy: Option<&crate::timers::Policy>) -> Option<String> {
    let trigger = policy?.trigger.as_ref()?;
    let names: Vec<&str> = trigger
        .sources
        .iter()
        .map(|s| match s.as_str() {
            "message" => "a new message",
            "email" => "a new email",
            _ => "another event",
        })
        .collect();
    let mut text = format!("Also runs on {}", names.join(" or "));
    if trigger.min_interval_s > 0 {
        text.push_str(&format!(
            ", at most every {}",
            span(i64::from(trigger.min_interval_s))
        ));
    }
    Some(text)
}

fn span(seconds: i64) -> String {
    match seconds {
        s if s % 3600 == 0 => format!("{} h", s / 3600),
        s if s % 60 == 0 => format!("{} min", s / 60),
        s => format!("{s} s"),
    }
}

/// The last run's outcome in words, or `None` before the first result.
pub fn last_result_label(
    stats: Option<&crate::timers::Stats>,
    local: Option<&str>,
) -> Option<String> {
    let stats = stats?;
    let kind = match stats.last_kind.as_deref()? {
        "delivered" => "Sent",
        "silent" => "Silent",
        "digest" => "Held for digest",
        _ => "Result",
    };
    let mut text = kind.to_owned();
    if let Some(summary) = stats.last_summary.as_deref().filter(|s| !s.is_empty()) {
        text.push_str(": ");
        text.push_str(&summary.chars().take(120).collect::<String>());
    }
    if let Some(at) = local
        .map(str::to_owned)
        .or_else(|| stats.last_at_ms.map(utc_time))
    {
        text.push_str(&format!(" ({at})"));
    }
    Some(text)
}

/// "3 silent runs since the last message", or `None` when there are none.
pub fn silent_runs_label(stats: Option<&crate::timers::Stats>) -> Option<String> {
    let n = stats?.silent_runs;
    (n > 0).then(|| {
        format!(
            "{n} silent run{} since the last message",
            if n == 1 { "" } else { "s" }
        )
    })
}

/// Whether the timer is running, and if not, why and until when.
/// `now_ms` is only used to ignore a pause that has already ended.
pub fn run_status(
    row: &crate::timers::Listed,
    conversation_pause_ms: Option<i64>,
    conversation_local: Option<&str>,
    now_ms: i64,
) -> String {
    use crate::timers::State;
    if row.detail.state != State::Enabled {
        return state_label(row.detail.state.as_str()).to_owned();
    }
    let own = row
        .policy
        .as_ref()
        .and_then(|p| p.pause_until_ms)
        .filter(|until| *until > now_ms);
    let chat = conversation_pause_ms.filter(|until| *until > now_ms);
    match (own, chat) {
        (None, None) => "Running".into(),
        (Some(own), Some(chat)) if chat > own => {
            format!("Chat paused{}", pause_tail(chat, conversation_local))
        }
        (Some(own), _) => pause_text(own, row.local.pause_until.as_deref()),
        (None, Some(chat)) => format!("Chat paused{}", pause_tail(chat, conversation_local)),
    }
}
fn pause_text(until: i64, local: Option<&str>) -> String {
    format!("Paused{}", pause_tail(until, local))
}
fn pause_tail(until: i64, local: Option<&str>) -> String {
    if until >= 4_102_444_800_000 {
        " until resumed".into()
    } else {
        format!(
            " until {}",
            local.map_or_else(|| utc_time(until), str::to_owned)
        )
    }
}
