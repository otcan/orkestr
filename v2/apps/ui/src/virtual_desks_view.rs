use dioxus::prelude::*;
use orkestr_v2_contracts::DesktopInventory;
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::Value;

/// Owner-wide inventory; entering this view never acquires or restarts a desk.
#[component]
pub fn VirtualDesks(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut list = use_signal(|| None::<DesktopInventory>);
    let mut status = use_signal(String::new);
    let mut loading = use_signal(|| true);
    let mut reload = use_signal(|| 0_u64);
    use_resource(move || {
        let _ = reload();
        async move {
            loading.set(true);
            let result = crate::transport::request::<DesktopInventory>(
                "GET",
                "/api/v2/desktops",
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            loading.set(false);
            match result {
                Ok(value) => {
                    list.set(Some(value));
                    status.set(String::new());
                }
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => {
                    list.set(None);
                    status.set(format!("Virtual desks unavailable: {}", error.message));
                }
            }
        }
    });
    rsx! {
        section { class: "settings-section", "aria-label": "Virtual desks",
            h3 { "Virtual desks" }
            p { class: "field-help", "All desk resources. Choose a connected chat when reserving or managing a desk." }
            button { r#type: "button", disabled: loading(), onclick: move |_| reload += 1,
                if loading() { "Refreshing…" } else { "Refresh" }
            }
            if !status().is_empty() { p { role: "status", "{status}" } }
            if let Some(value) = list() {
                p { class: "field-help", "Snapshot of desk runtime and reservation states. Refresh before acting on older information." }
                if value.resources.is_empty() { p { "No desk resources are available." } }
                for desk in value.resources {
                    crate::desktop_resource_card::DesktopResourceCard {
                        key: "{desk.slug}:{owner}",
                        bindings: value.bindings.iter().filter(|b| b.desktop_slugs.contains(&desk.slug)).cloned().collect::<Vec<_>>(),
                        desk, csrf: csrf.clone(), session_scope, onexpired,
                        onchanged: move |_| reload += 1,
                    }
                }
            } else if loading() { p { role: "status", "Loading all desk resources…" } }
        }
    }
}
