use dioxus::prelude::*;
use orkestr_v2_ui::held_inputs::{
    fresh_input_notice, reason, HeldInputs, CANCEL_UNAVAILABLE, RESUME_UNAVAILABLE,
};

/// Read evidence never authorizes release or cancellation.
#[component]
pub fn HeldInputsView(model: Signal<HeldInputs>, now_ms: u64) -> Element {
    let model = model.read();
    rsx! {
        section { "aria-label": "Held input",
            h3 { "Held input" }
            p { role: "status", "{model.status(now_ms)}" }
            p { "Stop keeps older queued input saved. Restarting or sending a new message does not automatically replay it." }
            if let Some(page) = model.displayed_page() {
                p { "{fresh_input_notice(page)}" }
                ol {
                    for input in &page.held {
                        li { key: "{input.message_id}",
                            h4 { "Saved message held after Stop" }
                            p { "{reason(input)}" }
                            p { "Message preview and saved time are unavailable in this list. Your message remains saved." }
                            details {
                              summary { "Message provenance" }
                              dl {
                                dt { "Saved message" } dd { "{input.message_id}" }
                                dt { "Source event" } dd { "{input.source_event_id}" }
                                dt { "Input sequence" } dd { "{input.scope_sequence}" }
                                dt { "Stop boundary run" } dd { "{input.boundary_run_id}" }
                                dt { "Stop boundary event" } dd { "{input.boundary_event_id}" }
                                dt { "Held through input sequence" } dd { "{input.through_scope_sequence}" }
                              }
                            }
                            button { disabled: true, title: RESUME_UNAVAILABLE, "Resume held input" }
                            p { "{RESUME_UNAVAILABLE}" }
                            button { disabled: true, title: CANCEL_UNAVAILABLE, "Cancel held input" }
                            p { "{CANCEL_UNAVAILABLE}" }
                        }
                    }
                }
                if page.next_after_sequence.is_some() {
                    p { "More held input exists on the next page." }
                }
            } else {
                button { disabled: true, title: RESUME_UNAVAILABLE, "Resume held input" }
                button { disabled: true, title: CANCEL_UNAVAILABLE, "Cancel held input" }
                p { "{RESUME_UNAVAILABLE}" }
                p { "{CANCEL_UNAVAILABLE}" }
            }
        }
    }
}
