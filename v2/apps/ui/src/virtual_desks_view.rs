use dioxus::prelude::*;
use orkestr_v2_contracts::DesktopInventory;
use orkestr_v2_ui::{desk_presentation::Availability, session_scope::SessionScope};
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
    let mut search = use_signal(String::new);
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
    let inventory = list();
    let desks = inventory.as_ref().map(|v| v.resources.len()).unwrap_or(0);
    let available = inventory
        .as_ref()
        .map(|v| {
            v.resources
                .iter()
                .filter(|d| Availability::from_lease(&d.lease_state) == Availability::Available)
                .count()
        })
        .unwrap_or(0);
    let reserved = inventory
        .as_ref()
        .map(|v| {
            v.resources
                .iter()
                .filter(|d| Availability::from_lease(&d.lease_state) == Availability::Reserved)
                .count()
        })
        .unwrap_or(0);
    let unchecked = desks - available - reserved;
    rsx! {
        section { class: "settings-section", "aria-label": "Virtual desks",
            style { "{include_str!(\"virtual_desks.css\")}" }
            h3 { "Virtual desks" }
            p { class: "field-help", "All desk resources. Start, stop or link a desk here, or reserve it from a connected chat." }
            button { r#type: "button", disabled: loading(), onclick: move |_| reload += 1,
                if loading() { "Refreshing…" } else { "Refresh" }
            }
            if !status().is_empty() { p { role: "status", "{status}" } }
            if let Some(value) = inventory {
                p { class: "field-help", "Snapshot of desk runtime and reservation states. Refresh before acting on older information." }
                div {class:"desk-summary", "aria-label":"Desk inventory summary",
                    span { "{desks} desks" }
                    span { "{available} available to reserve" }
                    span { "{reserved} reserved" }
                    span { "{unchecked} need checking" }
                }
                label { "Find a desk"
                    input { r#type:"search", placeholder:"Search name or ID…", value:"{search}", oninput:move |event|search.set(event.value()) }
                }
                if !value.resources.is_empty() && !value.resources.iter().any(|desk| format!("{} {}",desk.label,desk.slug).to_lowercase().contains(&search().trim().to_lowercase())) {
                    p {role:"status","No desks match your search."}
                }
                if value.resources.is_empty() { p { "No desk resources are available." } }
                ul {class:"desk-list", "aria-label":"Desks",
                for desk in value.resources {
                    crate::desktop_resource_row::DesktopResourceRow {
                        key: "{desk.slug}:{owner}",
                        visible: format!("{} {}",desk.label,desk.slug).to_lowercase().contains(&search().trim().to_lowercase()),
                        bindings: value.bindings.iter().filter(|b| b.desktop_slugs.contains(&desk.slug)).cloned().collect::<Vec<_>>(),
                        desk, csrf: csrf.clone(), session_scope, onexpired,
                        onchanged: move |_| reload += 1,
                        observed_at_ms: value.observed_at_ms,
                    }
                }
                }
            } else if loading() { p { role: "status", "Loading all desk resources…" } }
        }
    }
}
