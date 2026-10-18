use dioxus::prelude::*;
use orkestr_v2_ui::{
    session_scope::SessionScope,
    timers::{valid_namespace, Detail},
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
    rsx! {
        section { "aria-label":"Timers", h2 { "Timers" }
            p { "Open a saved timer using its ID from the import receipt. A timer list is not available here yet." }
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
