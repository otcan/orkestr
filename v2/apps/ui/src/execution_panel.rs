use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;

/// Status reads are active; Stop activation remains separately gated.
#[component]
pub fn ExecutionPanel(
    execution: Signal<Execution>,
    now_ms: u64,
    parent_tasks: bool,
    csrf: String,
    session_scope: Signal<orkestr_v2_ui::session_scope::SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let model = execution.read();
    rsx! {
        section { "aria-label": "Execution and resources",
            h3 { "Execution" }
            p { role: "status", "{model.summary(now_ms)}" }
            details { summary { "CPU and RAM" } p { "{model.resources(now_ms)}" } }
            crate::stop_button::StopButton { execution, csrf: csrf.clone(), session_scope, onexpired }
            if let Some(status) = model.control_status().filter(|s| s.progress.is_some()) {
                crate::progress_view::ProgressView { key: "{status.conversation_id}/{status.progress.as_ref().unwrap().payload_id}", status, csrf: csrf.clone(), execution, session_scope, onexpired }
            }
            crate::acceptance_button::AcceptanceButton { execution, csrf: csrf.clone(), session_scope, onexpired, now_ms }
            if parent_tasks {
                if let Some(status) = model.control_status() {
                    if let Some(parent) = &status.run_id {
                        crate::worker_tasks_panel::WorkerTasksPanel {
                            key: "{status.conversation_id}/{parent}/{session_scope.read().generation()}",
                            conversation: status.conversation_id.clone(), parent: parent.clone(),
                            csrf: csrf.clone(), session_scope, onexpired
                        }
                    }
                }
            }
            if let Some(status) = model.control_status() {
                crate::steering_view::SteeringView { key:"{status.conversation_id}/{status.run_id:?}/{session_scope.read().generation()}/{model.selection_generation()}", execution, session_scope, csrf:csrf.clone(), onexpired, now_ms }
            }
            p { "Keep editing or send another message while work runs. A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." }
        }
    }
}
