use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;

/// Status reads are active; Stop activation remains separately gated.
#[component]
pub fn ExecutionPanel(
    execution: Signal<Execution>,
    #[props(default)] compact: bool,
    now_ms: u64,
    parent_tasks: bool,
    csrf: String,
    session_scope: Signal<orkestr_v2_ui::session_scope::SessionScope>,
    onexpired: EventHandler<()>,
    #[props(default)] onaccepted: Option<EventHandler<i64>>,
) -> Element {
    let model = execution.read();
    let summary = if compact && model.fresh(now_ms) {
        use orkestr_v2_contracts::ExecutionPhase::*;
        model
            .control_status()
            .map(|s| match s.phase {
                Queued => "Message queued",
                Starting => "Starting work…",
                Running => "Deep is working",
                CancelRequested => "Stop requested; waiting for confirmation",
                Cancelled => "Work stopped",
                AwaitingAcceptance => "Proposed result ready for review",
                Completed => "Result accepted",
                Failed => "Work failed",
                Blocked => "Work needs attention",
            })
            .unwrap_or("Checking work status")
            .to_string()
    } else if compact && model.control_status().is_none() {
        "Waiting for current work status".into()
    } else {
        model.summary(now_ms)
    };
    rsx! {
        section { class: if compact { "execution-toolbar" } else { "execution-panel" }, "aria-label": "Execution and resources",
            if !compact { h3 { "Execution" } }
            p { class: "execution-summary", role: "status", "{summary}" }
            if !compact { details { summary { "CPU and RAM" } p { "{model.resources(now_ms)}" } } }
            crate::stop_button::StopButton { execution, csrf: csrf.clone(), session_scope, onexpired }
            if let Some(status) = model.control_status().filter(|s| !compact && s.progress.is_some()) {
                crate::progress_view::ProgressView { key: "{status.conversation_id}/{status.progress.as_ref().unwrap().payload_id}", status, csrf: csrf.clone(), execution, session_scope, onexpired }
            }
            if !compact || model.control_status().is_some_and(|s| s.phase == orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance) {
                crate::acceptance_button::AcceptanceButton { execution, csrf: csrf.clone(), session_scope, onexpired, now_ms, onaccepted }
            }
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
                details { class: "steer-drawer",
                    summary { "Steer running work" }
                    crate::steering_view::SteeringView { key:"{status.conversation_id}/{status.run_id:?}/{session_scope.read().generation()}/{model.selection_generation()}", execution, session_scope, csrf:csrf.clone(), onexpired, now_ms }
                }
            }
            if !compact { p { "A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." } }
        }
    }
}
