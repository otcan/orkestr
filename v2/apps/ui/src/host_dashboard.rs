//! Host dashboard: an overview (gauges, top consumers, disks, services) and
//! the time-range charts. `#host` and `#host/details?range=…` select them.
use dioxus::prelude::*;
use orkestr_v2_contracts::HostMetricsRange;
use orkestr_v2_ui::session_scope::SessionScope;

#[component]
pub fn HostDashboard(
    session_scope: Signal<SessionScope>,
    mut charts: Signal<bool>,
    range: Signal<HostMetricsRange>,
    onexpired: EventHandler<()>,
) -> Element {
    rsx! {
        div { class: "host-dashboard",
            nav { class: "hd-views", "aria-label": "Host views",
                button { r#type: "button", "aria-pressed": if !charts() { "true" } else { "false" }, onclick: move |_| charts.set(false), "Overview" }
                button { r#type: "button", "aria-pressed": if charts() { "true" } else { "false" }, onclick: move |_| charts.set(true), "Charts" }
            }
            if charts() {
                crate::host_metrics_view::HostMetricsView { session_scope, range, onexpired }
            } else {
                crate::host_overview::HostOverview { session_scope, onexpired,
                    oncharts: move |_| charts.set(true) }
            }
        }
    }
}
