use crate::timer_pause_view::PausePicker;
use dioxus::prelude::*;
use orkestr_v2_ui::{
    timer_labels::{
        last_result_label, run_status, schedule_label, silent_runs_label, trigger_label, utc_time,
    },
    timers::{Listed, State},
};

/// One timer: its rule in words, status, next run, last result and controls.
#[component]
pub fn TimerCard(
    row: Listed,
    chat_pause_ms: Option<i64>,
    chat_pause_local: Option<String>,
    now_ms: i64,
    busy: bool,
    onpause: EventHandler<(String, Option<i64>)>,
    onedit: EventHandler<Listed>,
    onadvanced: EventHandler<String>,
) -> Element {
    let label = row.label.clone().unwrap_or_else(|| "Timer".to_owned());
    let status = run_status(&row, chat_pause_ms, chat_pause_local.as_deref(), now_ms);
    let running = status == "Running";
    let paused = status.starts_with("Paused") || status.starts_with("Chat paused");
    let own_pause = row
        .policy
        .as_ref()
        .and_then(|p| p.pause_until_ms)
        .is_some_and(|until| until > now_ms);
    let rule = schedule_label(&row.detail.schedule);
    let trigger = trigger_label(row.policy.as_ref());
    let next = if row.detail.state == State::Enabled {
        row.local
            .next
            .clone()
            .or_else(|| row.detail.next_due_ms.map(utc_time))
            .filter(|_| !matches!(row.detail.schedule, orkestr_v2_ui::timers::Schedule::Event))
    } else {
        None
    };
    let last = last_result_label(row.stats.as_ref(), row.local.last_result.as_deref());
    let quiet = silent_runs_label(row.stats.as_ref());
    let silent_mode = row
        .policy
        .as_ref()
        .is_some_and(|p| p.silent_mode == "unless_changed");
    let digest = row
        .policy
        .as_ref()
        .and_then(|p| p.digest.as_ref())
        .map(|d| {
            format!(
                "Digest at {} ({})",
                d.minutes
                    .iter()
                    .map(|m| orkestr_v2_ui::timer_rules::clock(*m))
                    .collect::<Vec<_>>()
                    .join(", "),
                d.timezone
            )
        });
    let skips = row.policy.as_ref().map(|p| p.skip_dates.len()).unwrap_or(0);
    let namespace = row.detail.namespace.clone();
    let editable = row.native;
    let enabled = row.detail.state == State::Enabled;
    rsx! {
        li { key: "{namespace}", class: "timer-card", "data-status": if running { "running" } else if paused { "paused" } else { "off" },
            div { class: "timer-card-head",
                strong { "{label}" }
                span { class: "source-badge timer-status", "{status}" }
            }
            p { class: "timer-rule", "{rule}" }
            if let Some(text) = trigger { p { class: "field-help", "{text}" } }
            dl { class: "timer-facts",
                if row.detail.schedule != orkestr_v2_ui::timers::Schedule::Event {
                    div { dt { "Next run" } dd { if let Some(next) = next.clone() { "{next}" } else { "—" } } }
                }
                div { dt { "Last result" } dd { if let Some(text) = last.clone() { "{text}" } else { "No result yet" } } }
                if let Some(text) = quiet.clone() { div { dt { "Quiet" } dd { "{text}" } } }
            }
            div { class: "timer-tags",
                if silent_mode { span { class: "source-badge", "Silent unless new" } }
                if let Some(text) = digest { span { class: "source-badge", "{text}" } }
                if skips > 0 { span { class: "source-badge", "{skips} skipped date(s)" } }
            }
            div { class: "timer-actions",
                if enabled {
                    if own_pause {
                        button { r#type: "button", disabled: busy, onclick: { let ns = namespace.clone(); move |_| onpause.call((ns.clone(), None)) }, "Resume" }
                    } else {
                        PausePicker { label: format!("Pause {label}"), disabled: busy, onpick: { let ns = namespace.clone(); move |ms| onpause.call((ns.clone(), Some(ms))) } }
                    }
                }
                if editable { button { r#type: "button", disabled: busy, onclick: { let row = row.clone(); move |_| onedit.call(row.clone()) }, "Edit" } }
                button { r#type: "button", class: "quiet", onclick: { let ns = namespace.clone(); move |_| onadvanced.call(ns.clone()) }, "Details" }
            }
        }
    }
}
