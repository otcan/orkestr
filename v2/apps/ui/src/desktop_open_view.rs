use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

/// A bound desktop remains visible while its bridge is unavailable. Preparing
/// an owner link never edits grants or creates/restarts a desktop.
#[component]
pub fn DesktopOpen(
    conversation: String,
    slug: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    #[props(default = false)] compact: bool,
) -> Element {
    let owner = session_scope.read().generation();
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut link = use_signal(|| None::<String>);
    let path = format!("/api/v2/conversations/{conversation}/desktops/{slug}/open");
    rsx! {
        li {
            if !compact { strong { "{slug}" } }
            if let Some(url) = link() {
                a { href: url, target: "_blank", rel: "noopener noreferrer", "Open desktop" }
                span { class: "field-help", "The desktop may ask you to approve a viewing challenge." }
            } else {
                button { r#type: "button", disabled: busy(), onclick: move |_| {
                    if busy() { return; }
                    busy.set(true); status.set(String::new());
                    let (path, csrf) = (path.clone(), csrf.clone());
                    spawn(async move {
                        let result = crate::transport::request::<Value>("POST", &path, json!({}), &csrf, "").await;
                        if !session_scope.read().is_current(owner) { return; }
                        busy.set(false);
                        match result {
                            Ok(value) => if let Some(url) = value.get("url").and_then(Value::as_str) {
                                link.set(Some(url.to_owned()));
                            } else { status.set("Desktop viewing did not return a link.".into()); },
                            Err(error) if error.status == 401 => onexpired.call(()),
                            Err(error) => status.set(error.message),
                        }
                    });
                }, if busy() { "Preparing desktop…" } else if compact { "Get viewing link" } else { "Open desktop" } }
            }
            if !status().is_empty() { span { role: "status", class: "field-help", "{status}" } }
        }
    }
}
