use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;

/// Status reads are active; Stop activation remains separately gated.
#[component]
pub fn ExecutionPanel(
    execution: Signal<Execution>,
    now_ms: u64,
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
            crate::stop_button::StopButton { execution, csrf, session_scope, onexpired }
            button { r#type: "button", disabled: true, title: "Steering is unavailable. You can still send a message.", "Steer unavailable" }
            p { "Keep editing or send another message while work runs. A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." }
        }
    }
}
