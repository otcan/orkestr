use crate::timer_bridge;
use dioxus::prelude::*;
use orkestr_v2_contracts::ConversationId;
use orkestr_v2_ui::{
    session_scope::SessionScope,
    timer_rules::{Kind, RuleForm, WEEKDAYS},
};
use serde_json::{json, Value};

/// Create or edit a calendar or event timer. The summary line is the rule in
/// plain words as the server will read it; "Show next runs" asks the server.
#[component]
pub fn TimerEditor(
    conversation: String,
    csrf: String,
    initial: RuleForm,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    ondone: EventHandler<bool>,
) -> Element {
    let owner = session_scope.read().generation();
    let editing = initial.editing.clone();
    let mut form = use_signal(move || initial);
    let mut busy = use_signal(|| false);
    let mut notice = use_signal(String::new);
    let mut runs = use_signal(Vec::<String>::new);
    let current = form();
    let preview = current.build();
    let kind = current.kind;
    let is_edit = editing.is_some();
    let target_conversation = conversation.clone();
    let bodies_csrf = csrf.clone();
    let save = move |_| {
        if busy() {
            return;
        }
        let snapshot = form();
        let csrf = bodies_csrf.clone();
        let target = target_conversation.clone();
        busy.set(true);
        notice.set(String::new());
        spawn(async move {
            let outcome: Result<(), String> = async {
                if let Some(editing) = snapshot.editing.clone() {
                    let (schedule, policy) = snapshot.edit_bodies()?;
                    if let Some(body) = schedule {
                        let reply = timer_bridge::call(
                            "POST",
                            &format!("/api/v2/timers/{}/schedule", editing.namespace),
                            &csrf,
                            body,
                        )
                        .await?;
                        if !reply.ok() {
                            return Err(reply.failure());
                        }
                    }
                    let reply = timer_bridge::call(
                        "PUT",
                        &format!("/api/v2/timers/{}/policy", editing.namespace),
                        &csrf,
                        policy,
                    )
                    .await?;
                    if !reply.ok() {
                        return Err(reply.failure());
                    }
                    Ok(())
                } else {
                    let id = crate::transport::key().await.map_err(|e| e.message)?;
                    let conversation: ConversationId = serde_json::from_value(json!(target))
                        .map_err(|_| "Chat unavailable.".to_owned())?;
                    let body = snapshot.create_body(&id, &conversation)?;
                    let reply =
                        timer_bridge::call("POST", "/api/v2/timers/calendar", &csrf, body).await?;
                    if reply.ok() {
                        Ok(())
                    } else {
                        Err(reply.failure())
                    }
                }
            }
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            busy.set(false);
            match outcome {
                Ok(()) => ondone.call(true),
                Err(message) => {
                    if message.starts_with("Sign in") {
                        onexpired.call(());
                    }
                    notice.set(message);
                }
            }
        });
    };
    let preview_csrf = csrf.clone();
    let show_runs = move |_| {
        let Ok(built) = form().build() else { return };
        let csrf = preview_csrf.clone();
        spawn(async move {
            match timer_bridge::call(
                "POST",
                "/api/v2/timers/calendar/preview",
                &csrf,
                json!({"schedule": built.schedule, "count": 5}),
            )
            .await
            {
                Ok(reply) if reply.ok() => {
                    let list: Vec<String> = reply
                        .body
                        .as_ref()
                        .and_then(|b| b["runs_local"].as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    runs.set(list);
                }
                Ok(reply) => notice.set(reply.failure()),
                Err(message) => notice.set(message),
            }
        });
    };
    rsx! {
        form { class: "settings-form timer-editor", "aria-label": if is_edit { "Edit timer" } else { "New timer" },
            onsubmit: move |event| event.prevent_default(),
            h3 { if is_edit { "Edit timer" } else { "New timer" } }
            label { r#for: "timer-name", "Name" }
            input { id: "timer-name", value: "{current.label}", maxlength: 200, disabled: is_edit,
                oninput: move |e| form.write().label = e.value() }
            div { class: "field-row",
                div {
                    label { r#for: "timer-kind", "Runs" }
                    select { id: "timer-kind", disabled: is_edit,
                        onchange: move |e| form.write().kind = if e.value() == "event" { Kind::Event } else { Kind::Schedule },
                        option { value: "schedule", selected: kind == Kind::Schedule, "On a schedule" }
                        option { value: "event", selected: kind == Kind::Event, "When a message or email arrives" }
                    }
                }
                div {
                    label { r#for: "timer-zone", "Time zone" }
                    input { id: "timer-zone", value: "{current.timezone}", list: "timer-zones", placeholder: "Europe/Berlin",
                        oninput: move |e| form.write().timezone = e.value() }
                    datalist { id: "timer-zones",
                        for zone in ["Europe/Berlin", "Europe/Istanbul", "Europe/London", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Dubai"] { option { value: zone } }
                    }
                }
            }
            if kind == Kind::Schedule {
                fieldset { class: "weekday-row",
                    legend { "Days" }
                    for (index, name) in WEEKDAYS.iter().enumerate() {
                        label { class: "checkbox day", key: "{name}",
                            input { r#type: "checkbox", checked: current.weekdays[index], onchange: move |e| form.write().weekdays[index] = e.checked() }
                            "{name}"
                        }
                    }
                }
                div { class: "field-row field-row-3",
                    div { label { r#for: "timer-start", "From" } input { id: "timer-start", value: "{current.start}", placeholder: "08:00", inputmode: "numeric", oninput: move |e| form.write().start = e.value() } }
                    div { label { r#for: "timer-end", "Until (inclusive)" } input { id: "timer-end", value: "{current.end}", placeholder: "19:00", inputmode: "numeric", oninput: move |e| form.write().end = e.value() } }
                    div { label { r#for: "timer-every", "Every n hours" } input { id: "timer-every", value: "{current.every_hours}", inputmode: "numeric", oninput: move |e| form.write().every_hours = e.value() } }
                }
                label { r#for: "timer-minutes", "Minutes past the hour" }
                input { id: "timer-minutes", value: "{current.minutes}", placeholder: "0 or 0, 30", oninput: move |e| form.write().minutes = e.value() }
            }
            h4 { "Also run when something arrives" }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.on_message, onchange: move |e| form.write().on_message = e.checked() }
                "A new chat message"
            }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.on_email, onchange: move |e| form.write().on_email = e.checked() }
                "A new email"
            }
            if current.on_message || current.on_email {
                label { r#for: "timer-gap", "At most one event run every (seconds)" }
                input { id: "timer-gap", value: "{current.min_interval_s}", inputmode: "numeric", oninput: move |e| form.write().min_interval_s = e.value() }
            }
            h4 { "Results" }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.silent, onchange: move |e| form.write().silent = e.checked() }
                "Silent unless something changed (NO_REPLY or NO_NEWS sends nothing)"
            }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.digest_on, onchange: move |e| form.write().digest_on = e.checked() }
                "Send a digest of quiet runs"
            }
            if current.digest_on {
                label { r#for: "timer-digest", "Digest times (in the time zone above)" }
                input { id: "timer-digest", value: "{current.digest_times}", placeholder: "09:00", oninput: move |e| form.write().digest_times = e.value() }
            }
            label { r#for: "timer-skip", "Skip these dates (YYYY-MM-DD, comma separated)" }
            input { id: "timer-skip", value: "{current.skip_dates}", placeholder: "2026-12-25, 2026-12-26", oninput: move |e| form.write().skip_dates = e.value() }
            if !is_edit {
                label { r#for: "timer-text", "Instructions for each run" }
                textarea { id: "timer-text", rows: 4, value: "{current.instruction}", oninput: move |e| form.write().instruction = e.value() }
                p { class: "field-help", "The instructions are fixed when the timer is created. To change them, create a new timer and turn this one off." }
            }
            match preview {
                Ok(built) => rsx! { p { class: "timer-preview", role: "status", "{built.summary}" } },
                Err(message) => rsx! { p { class: "field-help timer-error", role: "status", "{message}" } },
            }
            if kind == Kind::Schedule {
                button { r#type: "button", class: "quiet", onclick: show_runs, "Show next runs" }
                if !runs().is_empty() { ul { class: "timer-runs", for run in runs() { li { key: "{run}", "{run}" } } } }
            }
            div { class: "timer-actions",
                button { r#type: "submit", disabled: busy() || form().build().is_err(), onclick: save, if busy() { "Saving…" } else if is_edit { "Save changes" } else { "Create and start" } }
                button { r#type: "button", class: "quiet", disabled: busy(), onclick: move |_| ondone.call(false), "Cancel" }
            }
            if !notice().is_empty() { p { role: "status", class: "settings-status", "{notice}" } }
        }
    }
}
