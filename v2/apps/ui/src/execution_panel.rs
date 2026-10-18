use dioxus::prelude::*;
use orkestr_v2_ui::execution::Execution;

/// Intentionally no guessed routes: ordinary API capabilities await Core/Runtime.
#[component]
pub fn ExecutionPanel() -> Element {
    let execution = Execution::default();
    rsx! {
        section { "aria-label": "Execution and resources",
            h3 { "Execution" }
            p { role: "status", "{execution.summary(0)}" }
            p { "Queue age: unavailable · Progress: unavailable" }
            details { summary { "CPU and RAM" } p { "{execution.resources(0)}" } }
            button { r#type: "button", disabled: true, title: "Awaiting ordinary execution API and confirmed cancellation receipt", "Stop unavailable" }
            button { r#type: "button", disabled: true, title: "Awaiting steering API; sending a message currently records intake only", "Steer unavailable" }
            p { "Keep editing or send another message while work runs. A cancellation request is not a confirmed stop. Stale or disconnected status never implies completion." }
        }
    }
}
