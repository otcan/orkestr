use dioxus::prelude::*;
use orkestr_v2_contracts::BetaDiscovery;
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope, workers::Workers};

/// Per-conversation work: configured controls, the Deep run with Stop/Steer and
/// worker tasks, window/queue state, independent workers and the linked V1
/// thread's V1 workers. Reading never starts work.
#[component]
pub fn WorkView(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<Execution>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut discovery = use_signal(|| None::<BetaDiscovery>);
    let workers = use_signal(Workers::default);
    let worker_execution = use_signal(Execution::default);
    rsx! {
        section { class: "work-view", "aria-label": "Work",
            h2 { "Work" }
            section { class: "conversation-controls", "aria-label": "Conversation controls",
                h3 { "Controls" }
                if let Some(value) = discovery() {
                    dl {
                        dt { "Provider" } dd { "{provider(&value)}" }
                        dt { "Role" } dd { "Deep (Fast and Workers when configured)" }
                        dt { "Model and reasoning effort" } dd { "Set by the server configuration for this provider" }
                        dt { "Stop" } dd { if value.controls.stop { "Available for the current run" } else { "Not available right now" } }
                        dt { "Steer" } dd { if value.controls.steer { "Available for the current run" } else { "Not available right now" } }
                    }
                } else {
                    crate::beta_discovery::BetaDiscoveryGate { key: "{id}-{owner}", conversation: Some(id.clone()), session_scope, onexpired,
                        onready: move |value: BetaDiscovery| discovery.set(Some(value)) }
                }
            }
            crate::execution_poll::ExecutionPoll { key: "work-{id}-{owner}", id: id.clone(), csrf: csrf.clone(), session_scope, execution, onexpired }
            crate::beta_window_view::WindowView { key: "work-window-{id}-{owner}", id: id.clone(), session_scope, onexpired }
            crate::workers_view::WorkersView { key: "workers-{id}-{owner}", id: id.clone(), csrf, session_scope, workers, execution: worker_execution, onexpired }
            crate::v1_workers_view::V1WorkersView { key: "v1-workers-{id}-{owner}", id, session_scope, onexpired }
        }
    }
}

fn provider(value: &BetaDiscovery) -> &'static str {
    match value.provider {
        orkestr_v2_contracts::BetaProvider::Codex => "Codex",
    }
}
