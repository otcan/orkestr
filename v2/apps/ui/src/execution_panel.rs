use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;

/// Intentionally no guessed routes: ordinary API capabilities await Core/Runtime.
#[component]
pub fn ExecutionPanel(execution: Signal<Execution>, now_ms: u64) -> Element {
    let execution = execution.read();
    rsx! {
        section { "aria-label": "Execution and resources",
            h3 { "Execution" }
            p { role: "status", "{execution.summary(now_ms)}" }
            details { summary { "CPU and RAM" } p { "{execution.resources(now_ms)}" } }
            button { r#type: "button", disabled: true, title: "No active execution available to stop", "Stop unavailable" }
            button { r#type: "button", disabled: true, title: "Steering is unavailable. You can still send a message.", "Steer unavailable" }
            p { "Keep editing or send another message while work runs. A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." }
        }
    }
}
