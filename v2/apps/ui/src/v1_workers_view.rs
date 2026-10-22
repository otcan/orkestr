use dioxus::prelude::*;
use orkestr_v2_contracts::V1WorkersPage;
use orkestr_v2_ui::{session_scope::SessionScope, sidebar::relative_time, v1_workers};
use serde_json::{json, Value};

/// V1 worker sub-threads of the conversation's linked V1 thread, polled on the
/// Work tab's status cadence. Hidden for a conversation without a V1 link.
/// Reading never starts work.
#[component]
pub fn V1WorkersView(
    id: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut page = use_signal(|| None::<V1WorkersPage>);
    let mut failed = use_signal(|| false);
    let mut show_retired = use_signal(|| false);
    let channel = use_hook(move || {
        let channel = document::eval(include_str!("execution_poll.js"));
        let _ = channel.send(json!({"path": format!("/api/v2/conversations/{id}/v1-workers")}));
        channel
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop": true}));
    });
    use_future(move || async move {
        let mut channel = channel;
        while let Ok(message) = channel.recv::<Value>().await {
            if !session_scope.read().is_current(owner) {
                let _ = channel.send(json!({"stop": true}));
                return;
            }
            match (message["kind"].as_str(), message["status"].as_u64()) {
                (Some("tick"), _) => {}
                (Some("response"), Some(200)) => {
                    match serde_json::from_value::<V1WorkersPage>(message["body"].clone()) {
                        Ok(value) if value.is_valid() => {
                            failed.set(false);
                            page.set(Some(value));
                        }
                        _ => failed.set(true),
                    }
                }
                (Some("response"), Some(401 | 403)) => {
                    let _ = channel.send(json!({"stop": true}));
                    onexpired.call(());
                    return;
                }
                // An older server without the route: keep the section hidden.
                (Some("response"), Some(404)) => page.set(None),
                _ => failed.set(true),
            }
        }
    });
    let Some(value) = page() else {
        return rsx! {};
    };
    if !v1_workers::shown(&value) {
        return rsx! {};
    }
    let showing = show_retired();
    let now = value.observed_at_ms;
    rsx! {
        section { class: "v1-workers", "aria-label": "V1 workers",
            h3 { "V1 workers" }
            if failed() {
                p { role: "status", "Could not refresh V1 workers; showing the last list." }
            }
            if let Some(text) = v1_workers::notice(&value, showing) {
                p { role: "status", "{text}" }
            }
            ul {
                for worker in v1_workers::visible(&value, showing) {
                    li { key: "{worker.thread_id}", "data-state": v1_workers::state_label(worker.state),
                        style: "margin-left: {(worker.depth.saturating_sub(1)).min(4)}em",
                        p {
                            if let Some(href) = v1_workers::link(worker) {
                                a { href: "{href}", "{worker.name}" }
                            } else {
                                span { "{worker.name}" }
                            }
                            " · {v1_workers::state_label(worker.state)}"
                            if worker.last_activity_ms.is_some() {
                                " · {relative_time(now, worker.last_activity_ms)}"
                            }
                        }
                        if let Some(preview) = &worker.preview {
                            p { class: "v1-worker-preview", "{preview.text}" }
                        }
                    }
                }
            }
            if let Some(label) = v1_workers::retired_toggle(&value, showing) {
                button { r#type: "button", "aria-pressed": "{showing}", onclick: move |_| show_retired.set(!showing), "{label}" }
            }
        }
    }
}
