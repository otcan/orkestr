use dioxus::prelude::*;
use orkestr_v2_contracts::{V1Desktops, V1ThreadSettings, V1Timer, V1TimerList, V1WhatsAppOptions};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    v1_manage::{options_update, schedule, TimerForm},
};
use serde_json::{json, Value};

fn base(thread: &str) -> String {
    format!("/api/v2/v1-threads/{thread}")
}

/// Model, effort, WhatsApp options and desktops of a linked V1 chat, managed
/// through V1's API. A chat delegated to V2 is shown read-only.
#[component]
pub fn V1Settings(
    thread: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    rsx! {
        section { class: "chat-settings", "aria-label": "V1 chat settings",
            ModelSettings { thread: thread.clone(), csrf: csrf.clone(), session_scope, onexpired }
            WhatsAppOptions { thread: thread.clone(), csrf, session_scope, onexpired }
            Desktops { thread, session_scope, onexpired }
        }
    }
}

#[component]
fn ModelSettings(
    thread: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut settings = use_signal(|| None::<V1ThreadSettings>);
    let mut model = use_signal(String::new);
    let mut effort = use_signal(String::new);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let path = format!("{}/settings", base(&thread));
    let read = path.clone();
    use_resource(move || {
        let path = read.clone();
        async move {
            let result =
                crate::transport::request::<V1ThreadSettings>("GET", &path, Value::Null, "", "")
                    .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => {
                    model.set(value.model.clone().unwrap_or_default());
                    effort.set(value.effort.clone().unwrap_or_default());
                    settings.set(Some(value));
                }
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => status.set(format!("Settings unavailable: {}", error.message)),
            }
        }
    });
    let Some(current) = settings() else {
        return rsx! { p { class: "settings-loading", if status().is_empty() { "Loading settings…" } else { "{status}" } } };
    };
    let efforts: Vec<String> = current
        .models
        .iter()
        .find(|m| m.id == model())
        .map(|m| m.efforts.clone())
        .unwrap_or_default();
    rsx! {
        form { class: "settings-form", "aria-label": "Model and effort", onsubmit: move |event| {
            event.prevent_default();
            if busy() { return; }
            busy.set(true);
            let (path, csrf) = (path.clone(), csrf.clone());
            let body = json!({"model": model(), "effort": effort()});
            spawn(async move {
                let result = crate::transport::request::<V1ThreadSettings>("PUT", &path, body, &csrf, "").await;
                if !session_scope.read().is_current(owner) { return; }
                busy.set(false);
                match result {
                    Ok(value) => { status.set("Saved in V1.".into()); settings.set(Some(value)); }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => status.set(error.message),
                }
            });
        },
            h3 { "Model and effort (V1)" }
            if current.read_only { p { class: "field-help", "V1 does not accept changes right now. {current.read_only_reason.clone().unwrap_or_default()}" } }
            div { class: "field-row",
                div {
                    label { r#for: "v1-model", "Model" }
                    select { id: "v1-model", onchange: move |e| model.set(e.value()),
                        for m in current.models.iter() { option { value: "{m.id}", selected: m.id == model(), "{m.id}" } }
                    }
                }
                div {
                    label { r#for: "v1-effort", "Effort" }
                    select { id: "v1-effort", onchange: move |e| effort.set(e.value()),
                        for e in efforts.iter() { option { value: "{e}", selected: *e == effort(), "{e}" } }
                    }
                }
            }
            button { r#type: "submit", disabled: busy() || current.read_only || model().is_empty() || effort().is_empty(), if busy() { "Saving…" } else { "Save model and effort" } }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}

#[component]
fn WhatsAppOptions(
    thread: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut options = use_signal(|| None::<V1WhatsAppOptions>);
    let mut prefix = use_signal(String::new);
    let mut participants = use_signal(String::new);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let path = format!("{}/whatsapp", base(&thread));
    let read = path.clone();
    let mut load = move |value: V1WhatsAppOptions| {
        prefix.set(value.reply_prefix.clone().unwrap_or_default());
        participants.set(value.additional_participant_ids.join("\n"));
        options.set(Some(value));
    };
    use_resource(move || {
        let path = read.clone();
        async move {
            let result =
                crate::transport::request::<V1WhatsAppOptions>("GET", &path, Value::Null, "", "")
                    .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => load(value),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => {
                    status.set(format!("WhatsApp options unavailable: {}", error.message))
                }
            }
        }
    });
    let Some(current) = options() else {
        return rsx! { p { class: "settings-loading", "{status}" } };
    };
    if current.chat_id.is_none() {
        return rsx! { div { class: "settings-form", h3 { "WhatsApp" } p { class: "field-help", "This V1 thread has no WhatsApp chat." } } };
    }
    let locked = current.delegated;
    rsx! {
        form { class: "settings-form", "aria-label": "WhatsApp options", onsubmit: move |event| {
            event.prevent_default();
            if busy() || locked { return; }
            let Some(current) = options() else { return };
            let update = match options_update(&current, &prefix(), &participants()) { Ok(u) => u, Err(m) => { status.set(m.into()); return; } };
            busy.set(true);
            let (path, csrf) = (path.clone(), csrf.clone());
            spawn(async move {
                let result = crate::transport::request::<V1WhatsAppOptions>("PUT", &path, json!(update), &csrf, "").await;
                if !session_scope.read().is_current(owner) { return; }
                busy.set(false);
                match result {
                    Ok(value) => { load(value); status.set("Saved in V1.".into()); }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => status.set(error.message),
                }
            });
        },
            h3 { "WhatsApp" }
            p { class: "field-help", "Group: {current.display_name.clone().unwrap_or_default()}" }
            if locked { p { class: "field-help", "This chat runs on V2; its WhatsApp options are managed there." } }
            label { r#for: "v1-prefix", "Reply prefix" }
            input { id: "v1-prefix", value: "{prefix}", disabled: locked, maxlength: 64, oninput: move |e| prefix.set(e.value()) }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.suppress_updates, disabled: locked, onchange: move |e| if let Some(o) = options.write().as_mut() { o.suppress_updates = e.checked(); } }
                "Send only final answers to the group (no progress updates)"
            }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.suppress_debug_footer, disabled: locked, onchange: move |e| if let Some(o) = options.write().as_mut() { o.suppress_debug_footer = e.checked(); } }
                "Hide the model/quota footer"
            }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.additional_participants_enabled, disabled: locked, onchange: move |e| if let Some(o) = options.write().as_mut() { o.additional_participants_enabled = e.checked(); } }
                "Other people in the group may instruct this chat"
            }
            label { r#for: "v1-participants", "Allowed participants (one WhatsApp id per line)" }
            textarea { id: "v1-participants", rows: 3, value: "{participants}", disabled: locked, oninput: move |e| participants.set(e.value()) }
            button { r#type: "submit", disabled: busy() || locked, if busy() { "Saving…" } else { "Save WhatsApp options" } }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}

#[component]
fn Desktops(
    thread: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut desktops = use_signal(|| None::<V1Desktops>);
    let mut status = use_signal(String::new);
    let path = format!("{}/desktops", base(&thread));
    use_resource(move || {
        let path = path.clone();
        async move {
            let result =
                crate::transport::request::<V1Desktops>("GET", &path, Value::Null, "", "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => desktops.set(Some(value)),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => status.set(format!("Desktops unavailable: {}", error.message)),
            }
        }
    });
    rsx! {
        div { class: "settings-form", "aria-label": "Desktops",
            h3 { "Desktops (V1)" }
            if let Some(d) = desktops() {
                if d.grants.is_empty() { p { class: "field-help", "No desktops are granted to this thread." } }
                ul { class: "lease-list",
                    for grant in d.grants { li { key: "{grant.slug}", strong { "{grant.slug}" } span { class: "field-help", "{grant.permissions.join(\", \")}" } } }
                }
                h4 { "Leases" }
                if d.leases.is_empty() { p { class: "field-help", "No leases." } }
                ul { class: "lease-list",
                    for lease in d.leases { li { strong { "{lease.slug}" } span { class: "source-badge", "{lease.state}" } if let Some(at) = lease.expires_at { span { class: "field-help", " until {at}" } } } }
                }
                p { class: "field-help", "Grants are changed in V1; leases are taken and released by the thread's work." }
            } else {
                p { class: "field-help", if status().is_empty() { "Loading desktops…" } else { "{status}" } }
            }
        }
    }
}

/// The thread's V1 timers: list, create, edit, pause, resume, delete.
#[component]
pub fn V1Timers(
    thread: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut timers = use_signal(|| None::<Vec<V1Timer>>);
    let mut form = use_signal(TimerForm::default);
    let mut open = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut reload = use_signal(|| 0_u32);
    let root = format!("{}/timers", base(&thread));
    let read = root.clone();
    use_resource(move || {
        let _ = reload();
        let path = read.clone();
        async move {
            let result =
                crate::transport::request::<V1TimerList>("GET", &path, Value::Null, "", "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => timers.set(Some(value.timers)),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => status.set(format!("Timers unavailable: {}", error.message)),
            }
        }
    });
    let act = {
        let (root, csrf) = (root.clone(), csrf.clone());
        move |method: &'static str, suffix: String| {
            if busy() {
                return;
            }
            busy.set(true);
            let (path, csrf) = (format!("{root}/{suffix}"), csrf.clone());
            spawn(async move {
                let result = crate::transport::request_status::<Value>(
                    method,
                    &path,
                    if method == "DELETE" {
                        Value::Null
                    } else {
                        json!({})
                    },
                    &csrf,
                )
                .await;
                if !session_scope.read().is_current(owner) {
                    return;
                }
                busy.set(false);
                match result {
                    Ok(_) => {
                        status.set("Saved in V1.".into());
                        reload += 1;
                    }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) if error.status == 0 && method == "DELETE" => {
                        status.set("Deleted in V1.".into());
                        reload += 1;
                    }
                    Err(error) => status.set(error.message),
                }
            });
        }
    };
    let rows = timers().unwrap_or_default();
    let current = form();
    rsx! {
        section { class: "chat-settings", "aria-label": "V1 timers",
            div { class: "settings-form",
                h3 { "Timers (V1)" }
                if timers().is_none() { p { class: "field-help", if status().is_empty() { "Loading timers…" } else { "{status}" } } }
                if timers().is_some() && rows.is_empty() { p { class: "field-help", "No timers." } }
                ul { class: "timer-list",
                    for timer in rows {
                        li { key: "{timer.id}", class: "v1-timer",
                            div { strong { "{timer.label.clone().unwrap_or_else(|| timer.id.clone())}" }
                                span { class: "source-badge", if timer.owned_by_v2 { "run by V2" } else if timer.enabled { "active" } else { "paused" } }
                                span { class: "field-help", " {schedule(&timer)}" }
                                if let Some(next) = timer.next_run_at.clone() { span { class: "field-help", " · next {next}" } }
                            }
                            if !timer.owned_by_v2 {
                                div { class: "timer-actions",
                                    button { r#type: "button", disabled: busy(), onclick: { let t = timer.clone(); move |_| { form.set(TimerForm::edit(&t)); open.set(true); } }, "Edit" }
                                    if timer.enabled {
                                        button { r#type: "button", disabled: busy(), onclick: { let id = timer.id.clone(); let mut act = act.clone(); move |_| act("POST", format!("{id}/pause")) }, "Pause" }
                                    } else {
                                        button { r#type: "button", disabled: busy(), onclick: { let id = timer.id.clone(); let mut act = act.clone(); move |_| act("POST", format!("{id}/resume")) }, "Resume" }
                                    }
                                    button { r#type: "button", class: "danger", disabled: busy(), onclick: { let id = timer.id.clone(); let mut act = act.clone(); move |_| act("DELETE", id.clone()) }, "Delete" }
                                }
                            }
                        }
                    }
                }
                button { r#type: "button", onclick: move |_| { form.set(TimerForm::default()); open.set(!open()); }, if open() { "Close" } else { "New timer" } }
                if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
            }
            if open() {
                form { class: "settings-form", "aria-label": "Timer", onsubmit: move |event| {
                    event.prevent_default();
                    if busy() { return; }
                    busy.set(true);
                    let (root, csrf) = (root.clone(), csrf.clone());
                    spawn(async move {
                        let result = async {
                            let key = crate::transport::key().await?;
                            let input = form.write().prepare(key).map_err(|m| crate::transport::Failure::from(m.to_string()))?;
                            let (method, path) = match form.read().editing.clone() { Some(id) => ("PATCH", format!("{root}/{id}")), None => ("POST", root.clone()) };
                            crate::transport::request_status::<V1Timer>(method, &path, json!(input), &csrf).await
                        }.await;
                        if !session_scope.read().is_current(owner) { return; }
                        busy.set(false);
                        match result {
                            Ok(_) => { form.set(TimerForm::default()); open.set(false); status.set("Saved in V1.".into()); reload += 1; }
                            Err(error) if error.status == 401 => onexpired.call(()),
                            Err(error) => {
                                if matches!(error.status, 400 | 404 | 409) { form.write().pending = None; }
                                status.set(error.message);
                            }
                        }
                    });
                },
                    h3 { if current.editing.is_some() { "Edit timer" } else { "New timer" } }
                    label { r#for: "v1-timer-label", "Label" }
                    input { id: "v1-timer-label", value: "{current.label}", oninput: move |e| form.write().label = e.value() }
                    div { class: "field-row",
                        div {
                            label { r#for: "v1-timer-cadence", "Repeat" }
                            select { id: "v1-timer-cadence", onchange: move |e| form.write().cadence = e.value(),
                                for (value, name) in [("daily", "Daily"), ("weekly", "Weekly"), ("interval", "Every…"), ("once", "Once")] {
                                    option { value, selected: current.cadence == value, "{name}" }
                                }
                            }
                        }
                        div {
                            if current.cadence == "interval" {
                                label { r#for: "v1-timer-every", "Every (30m, 2h, 1d)" }
                                input { id: "v1-timer-every", value: "{current.every}", oninput: move |e| form.write().every = e.value() }
                            } else if current.cadence == "once" {
                                label { r#for: "v1-timer-run-at", "At (ISO time)" }
                                input { id: "v1-timer-run-at", value: "{current.run_at}", placeholder: "2026-01-01T09:00:00Z", oninput: move |e| form.write().run_at = e.value() }
                            } else {
                                label { r#for: "v1-timer-time", "Time (HH:MM)" }
                                input { id: "v1-timer-time", value: "{current.time}", oninput: move |e| form.write().time = e.value() }
                            }
                        }
                    }
                    label { r#for: "v1-timer-zone", "Time zone" }
                    input { id: "v1-timer-zone", value: "{current.timezone}", oninput: move |e| form.write().timezone = e.value() }
                    label { r#for: "v1-timer-prompt", "Prompt" }
                    textarea { id: "v1-timer-prompt", rows: 3, value: "{current.prompt}", oninput: move |e| form.write().prompt = e.value() }
                    button { r#type: "submit", disabled: busy(), if current.pending.is_some() { "Retry" } else { "Save timer" } }
                }
            }
        }
    }
}
