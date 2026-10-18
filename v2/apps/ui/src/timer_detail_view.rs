use dioxus::prelude::*;
use orkestr_v2_ui::timer_labels::{controller_notice, held_reason, state_label};

/// Presentation waiting for the exact published HTTP adapter. No wire authority.
#[component]
pub fn TimerDetail(
    namespace: String,
    state: String,
    dormant_reason: Option<String>,
    controller_armed: bool,
) -> Element {
    let mut text = use_signal(String::new);
    rsx! {
        section { "aria-label": "Timer details",
            h2 { "Timer details" }
            p { role: "status", "{state_label(&state)}" }
            if let Some(reason) = held_reason(dormant_reason.as_deref()) { p { "{reason}" } }
            p { "{controller_notice(&state, controller_armed)}" }
            p { "Schedule details and the next scheduled time are unavailable here until the timer connection is ready." }
            label { r#for: "timer-owner-text", "What should this timer ask the assistant to do?" }
            textarea { id: "timer-owner-text", value: "{text}", oninput: move |event| text.set(event.value()) }
            p { "Write fresh instructions for the selected conversation. Imported instructions are not copied." }
            button { disabled: true, title: "Timer connection is not ready. Your text remains editable.", "Enable timer" }
            button { disabled: true, title: "Timer connection is not ready.", "Disable timer" }
            p { "Timer controls are unavailable until the timer connection is ready. No change has been requested." }
            details { summary { "Timer provenance" } p { "{namespace}" } }
        }
    }
}
