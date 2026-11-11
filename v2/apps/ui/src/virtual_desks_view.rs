use dioxus::prelude::*;
use orkestr_v2_contracts::{DesktopInventory, DesktopSharing};
use orkestr_v2_ui::{
    desk_presentation::{Availability, DeskSharing, LEGEND},
    session_scope::SessionScope,
};
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
    let mut sharing = use_signal(|| None::<DesktopSharing>);
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
            // Read on its own, so the switch works while V1 is unreachable. A
            // server without it has no switch: each chat keeps its own desks.
            let shared = crate::transport::request::<DesktopSharing>(
                "GET",
                "/api/v2/desktop-sharing",
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            sharing.set(shared.ok());
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
    let shared = sharing().is_some_and(|s| s.share_all_desks);
    rsx! {
        section { class: "settings-section", "aria-label": "Virtual desks",
            style { "{include_str!(\"virtual_desks.css\")}" }
            h3 { "Virtual desks" }
            p { class: "field-help", "{DeskSharing::inventory_help(shared)}" }
            crate::desk_sharing_view::DeskSharingSwitch { sharing, csrf: csrf.clone(), session_scope, onexpired, onchanged: move |_| reload += 1 }
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
                p { class: "field-help desk-legend", "{LEGEND}" }
                div { class: "desk-inventory",
                table {class:"desk-table", role:"table", "aria-label":"Desks",
                thead { role: "rowgroup",
                    tr { role: "row",
                        th { "scope": "col", role: "columnheader", "Desk" }
                        th { "scope": "col", role: "columnheader", "Reservation" }
                        th { "scope": "col", role: "columnheader", "Runtime" }
                        th { "scope": "col", role: "columnheader", "Held by" }
                        th { "scope": "col", role: "columnheader", "Actions" }
                    }
                }
                for desk in value.resources {
                    crate::desktop_resource_row::DesktopResourceRow {
                        key: "{desk.slug}:{owner}",
                        visible: format!("{} {}",desk.label,desk.slug).to_lowercase().contains(&search().trim().to_lowercase()),
                        // Shared: every chat with a desk binding may reserve every desk.
                        bindings: value.bindings.iter().filter(|b| shared || b.desktop_slugs.contains(&desk.slug)).cloned().collect::<Vec<_>>(),
                        shared, desk, csrf: csrf.clone(), session_scope, onexpired,
                        onchanged: move |_| reload += 1,
                        observed_at_ms: value.observed_at_ms,
                    }
                }
                }
                }
            } else if loading() { p { role: "status", "Loading all desk resources…" } }
        }
    }
}
