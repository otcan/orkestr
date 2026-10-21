use dioxus::prelude::*;
use orkestr_v2_ui::{
    session_scope::SessionScope,
    timer_labels::{schedule_label, state_label, utc_time},
    timers::{listing, valid_namespace, Detail, Listed},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn Timers(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut entered = use_signal(String::new);
    let mut selected = use_signal(String::new);
    let owner = session_scope.read().generation();
    let mut timers = use_signal(|| None::<Vec<Listed>>);
    let mut list_notice = use_signal(String::new);
    let list_conversation = conversation.clone();
    use_resource(move || {
        let conversation = list_conversation.clone();
        async move {
            let path = format!("/api/v2/conversations/{conversation}/timers");
            let result =
                crate::transport::request::<Value>("GET", &path, Value::Null, "", "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => match listing(&value, &conversation) {
                    Some(rows) => timers.set(Some(rows)),
                    None => list_notice.set("Timer list could not be verified.".into()),
                },
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => list_notice.set(format!("Timer list unavailable: {}", error.message)),
            }
        }
    });
    rsx! {
        section { "aria-label":"Timers", h2 { "Timers" }
            if let Some(rows) = timers() {
                if rows.is_empty() { p { class: "field-help", "This chat has no timers." } }
                ul { class: "timer-list",
                    for (row, label) in rows.into_iter().map(|r| { let label = r.label.clone().unwrap_or_else(|| "Timer".to_owned()); (r, label) }) {
                        li { key: "{row.detail.namespace}",
                            button { class: "timer-row", "aria-current": if selected() == row.detail.namespace { "true" } else { "false" },
                                onclick: { let id = row.detail.namespace.clone(); move |_| selected.set(id.clone()) },
                                strong { "{label}" }
                                span { class: "source-badge", "{state_label(row.detail.state.as_str())}" }
                                span { class: "field-help", "{schedule_label(&row.detail.schedule)}" }
                                if let Some(due) = row.detail.next_due_ms { span { class: "field-help", "Next: {utc_time(due)}" } }
                            }
                        }
                    }
                }
            } else {
                p { class: "field-help", if list_notice().is_empty() { "Loading timers…" } else { "{list_notice}" } }
            }
            p { "Select a timer to pause (disable), resume (enable with fresh instructions), stop or roll it back. Or open a saved timer by its ID." }
            form { onsubmit:move |event| {event.prevent_default();if valid_namespace(&entered()) {selected.set(entered().to_ascii_lowercase());}},
                label { r#for:"timer-id", "Saved timer ID" }
                input { id:"timer-id", value:"{entered}", oninput:move |event|entered.set(event.value()), required:true }
                button { disabled:!valid_namespace(&entered()), "Open timer" }
            }
            if !selected().is_empty() {
                TimerPanel { key:"{selected()}-{conversation}-{session_scope.read().generation()}", namespace:selected(), conversation, csrf, session_scope, onexpired }
            }
        }
    }
}
#[component]
fn TimerPanel(
    namespace: String,
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let detail = use_signal(|| None::<Detail>);
    let fresh = use_signal(|| false);
    let mut epoch = use_signal(|| 0u64);
    rsx! {
        div {key:"{epoch()}", TimerRead {namespace, detail, fresh, epoch, selected_epoch:epoch(),session_scope,onexpired} }
        crate::timer_detail_view::TimerDetail {detail,fresh,epoch,conversation,csrf,session_scope,onexpired}
        button {onclick:move |_|epoch+=1,"Refresh timer details"}
    }
}
#[component]
fn TimerRead(
    namespace: String,
    mut detail: Signal<Option<Detail>>,
    mut fresh: Signal<bool>,
    epoch: Signal<u64>,
    selected_epoch: u64,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    let path = format!("/api/v2/timers/{namespace}");
    let channel = use_hook(move || {
        fresh.set(false);
        let eval = document::eval(include_str!("execution_poll.js"));
        let _ = eval.send(json!({"path":path}));
        eval
    });
    let mut notice = use_signal(|| "Loading timer…");
    use_drop(move || {
        dropped.set(false);
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let active = active.clone();
        let namespace = namespace.clone();
        async move {
            let mut channel = channel;
            while let Ok(message) = channel.recv::<Value>().await {
                if !active.get()
                    || !session_scope.read().is_current(owner)
                    || epoch() != selected_epoch
                {
                    let _ = channel.send(json!({"stop":true}));
                    return;
                }
                if message["kind"] == "tick" {
                    continue;
                }
                let code = message["status"].as_u64().unwrap_or(0);
                if code == 401 || code == 403 {
                    let _ = channel.send(json!({"stop":true}));
                    onexpired.call(());
                    return;
                }
                let parsed = if code == 200 {
                    serde_json::from_value::<Detail>(message["body"].clone()).ok()
                } else {
                    None
                };
                if let Some(next) = parsed.filter(|next| {
                    next.valid_for(&namespace)
                        && detail
                            .read()
                            .as_ref()
                            .is_none_or(|old| next.revision >= old.revision)
                }) {
                    detail.set(Some(next));
                    fresh.set(true);
                    notice.set("Timer details updated.");
                } else {
                    fresh.set(false);
                    notice.set(if code == 404 {
                        "Saved timer unavailable for this account."
                    } else {
                        "Timer details unavailable. Refresh or reconnect."
                    });
                }
            }
            if active.get() && session_scope.read().is_current(owner) && epoch() == selected_epoch {
                fresh.set(false);
                notice.set("Timer connection interrupted.");
            }
        }
    });
    rsx! {p {role:"status","{notice}"}}
}
