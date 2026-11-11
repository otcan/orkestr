use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;
use orkestr_v2_ui::run_state::{run_view, Observation};

/// Status reads are active; Stop activation remains separately gated.
///
/// `compact` is the conversation's run-state line next to the composer
/// (ORK-786): one state, in words, with only the controls that state allows.
/// Stop and Steer are offered only for a run that supports them; finished
/// work shows its outcome and never an enabled Stop or Steer.
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
    #[props(default = true)] allow_steer: bool,
    /// The conversation accepts replies automatically: no Accept prompt here.
    #[props(default)]
    auto_accept: bool,
) -> Element {
    let model = execution.read();
    let status = model.control_status();
    let view = run_view(Observation {
        status: status.as_ref(),
        observed: model.observed(),
        connected: model.connected(),
        fresh: model.fresh(now_ms),
        auto_accept,
    });
    let summary = if compact {
        view.label.clone()
    } else {
        model.summary(now_ms)
    };
    // Stop evidence (a pending request, a receipt or a refusal) stays visible
    // after the run moves on, as text without a control.
    let stop_notice = status
        .as_ref()
        .filter(|_| !view.stop)
        .and_then(|s| model.stops.notice(s));
    rsx! {
        if !compact {
            if let Some(notice) = status.as_ref().and_then(orkestr_v2_ui::execution::failure_notice) {
                p { class: "execution-failure", "{notice}" }
            }
        }
        section { class: if compact { "execution-toolbar run-state" } else { "execution-panel" }, "aria-label": if compact { "Run state" } else { "Execution and resources" }, "data-run-state": "{view.state.slug()}",
            if !compact { h3 { "Execution" } }
            p { class: "execution-summary", role: "status", "{summary}" }
            if compact {
                if let Some(detail) = view.detail.clone() { p { class: "execution-model", "{detail}" } }
            } else if let Some(status) = status.as_ref() {
                p { class: "execution-model", "{orkestr_v2_ui::execution::model_label(status)}" }
            }
            if !compact { details { summary { "CPU and RAM" } p { "{model.resources(now_ms)}" } } }
            if view.stop {
                crate::stop_button::StopButton { execution, csrf: csrf.clone(), session_scope, onexpired }
            } else if let Some(notice) = stop_notice {
                p { class: "stop-notice", role: "status", "{notice}" }
            }
            if let Some(status) = status.clone().filter(|s| !compact && s.progress.is_some()) {
                crate::progress_view::ProgressView { key: "{status.conversation_id}/{status.progress.as_ref().unwrap().payload_id}", status, csrf: csrf.clone(), execution, session_scope, onexpired }
            }
            if !compact || view.accept {
                crate::acceptance_button::AcceptanceButton { execution, csrf: csrf.clone(), session_scope, onexpired, now_ms, onaccepted }
            }
            if parent_tasks {
                if let Some(status) = status.as_ref() {
                    if let Some(parent) = &status.run_id {
                        crate::worker_tasks_panel::WorkerTasksPanel {
                            key: "{status.conversation_id}/{parent}/{session_scope.read().generation()}",
                            conversation: status.conversation_id.clone(), parent: parent.clone(),
                            csrf: csrf.clone(), session_scope, onexpired
                        }
                    }
                }
            }
            if let Some(status) = status.as_ref().filter(|_| allow_steer && view.steer) {
                details { key: "{status.conversation_id}/{status.run_id:?}/{session_scope.read().generation()}/{model.selection_generation()}", class: "steer-drawer",
                    summary { "Steer running work" }
                    crate::steering_view::SteeringView { execution, session_scope, csrf:csrf.clone(), onexpired, now_ms }
                }
            }
            if !compact { p { "A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." } }
        }
    }
}
