use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn AutomaticReplies(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut page = use_signal(|| Value::Null);
    let mut notice = use_signal(|| "Loading automatic-reply permissions…".to_string());
    let mut busy = use_signal(|| true);
    let mut pending = use_signal(|| false);
    let mut channel = use_signal(|| None::<document::Eval>);
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let retired = active.clone();
    let owner = session_scope.read().generation();
    use_drop(move || {
        retired.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_future(move || {
        let id = id.clone();
        let csrf = csrf.clone();
        let active = active.clone();
        async move {
            let source = format!(
                "{}\n{}\n{}",
                include_str!("automatic_replies/state.mjs").replace("export ", ""),
                include_str!("automatic_replies/client.mjs")
                    .replace("import {PermissionState} from './state.mjs';", "")
                    .replace("export ", ""),
                include_str!("automatic_replies/bridge.js")
            );
            let eval = document::eval(&source);
            if eval.send(json!({"conversation":id,"csrf":csrf})).is_err() {
                notice
                    .set("Permissions unavailable. Reopen this conversation to reconnect.".into());
                busy.set(false);
                return;
            }
            channel.set(Some(eval));
            let mut eval = eval;
            while let Ok(value) = eval.recv::<Value>().await {
                if !active.get() || !session_scope.read().is_current(owner) {
                    let _ = eval.send(json!({"stop":true}));
                    return;
                }
                if value["status"] == 401 {
                    onexpired.call(());
                    return;
                }
                page.set(value["page"].clone());
                notice.set(
                    value["notice"]
                        .as_str()
                        .unwrap_or("Permissions unavailable.")
                        .into(),
                );
                pending.set(value["pending"].as_bool().unwrap_or(false));
                busy.set(false);
            }
            if active.get() && session_scope.read().is_current(owner) {
                notice
                    .set("Permissions disconnected. Reopen this conversation to reconnect.".into());
                busy.set(false);
            }
        }
    });
    let mut send = move |action: Value| {
        if busy() || !session_scope.read().is_current(owner) {
            return;
        }
        if let Some(eval) = channel.read().as_ref() {
            if eval.send(action).is_ok() {
                busy.set(true);
            }
        }
    };
    let routes = page.read()["routes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let next = page.read()["next_after"].as_str().map(str::to_string);
    rsx! {
        section { "aria-label":"Automatic replies",
            h3 { "Automatic replies" }
            p { "This permission does not indicate an active connection. Changing it does not release held messages or confirm delivery." }
            p { role:"status", "{notice}" }
            button { disabled:busy()||pending(), onclick:move |_|send(json!({"kind":"read"})), "Refresh permissions" }
            if pending() {
                p { "Your permission change is unconfirmed. Retry keeps the original choice." }
                button { disabled:busy(), onclick:move |_|send(json!({"kind":"decide"})), "Retry original permission change" }
            }
            if !page.read().is_null() && routes.is_empty() {
                p { "No configured automatic-reply routes on this page." }
            }
            ul {
                for (index, route) in routes.iter().enumerate() {
                    li { key:r#"{route["route_id"]}"#,
                        h4 { "Reply connection {index + 1}" }
                        p { if route["enabled"] == true { "Automatic replies allowed" } else { "Automatic replies paused" } }
                        button { disabled:busy()||pending(), onclick:{let route=route.clone();move |_|send(json!({"kind":"decide","route":route["route_id"],"enabled":route["enabled"]!=true}))},
                            if route["enabled"] == true { "Pause automatic replies" } else { "Allow automatic replies" }
                        }
                        details { summary { "Connection identity" } p { r#"{route["route_id"]}"# } }
                    }
                }
            }
            if let Some(next) = next {
                button { disabled:busy()||pending(), onclick:move |_|send(json!({"kind":"read","after":next})), "Next reply connections" }
                p { "Pages are refreshed separately and may reflect changes made between reads." }
            }
        }
    }
}
