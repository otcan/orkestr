use dioxus::prelude::*;
use orkestr_v2_ui::held_inputs::{fresh_input_notice, held_shown, reason, HeldInputs};

/// Messages Stop kept back (Work page, ORK-809). Shown only when there are
/// any: no empty section and no controls that cannot act. Read evidence never
/// authorizes release or cancellation.
#[component]
pub fn HeldInputsView(
    model: Signal<HeldInputs>,
    projection: Signal<orkestr_v2_ui::Projection>,
    now_ms: u64,
) -> Element {
    let model = model.read();
    let Some(page) = model.displayed_page().filter(|_| held_shown(&model)) else {
        return rsx! {};
    };
    rsx! {
        section { class: "held-input-list", "aria-label": "Held messages",
            h3 { "Held after Stop" }
            p { role: "status", "{model.status(now_ms)}" }
            p { "Stop keeps these messages saved. They are not sent again automatically; send a new message to continue. {fresh_input_notice(page)}" }
            ol {
                for input in &page.held {
                    li { key: "{input.message_id}",
                        p { "{reason(input)}" }
                        if let Some(preview) = orkestr_v2_ui::held_inputs::saved_preview(&projection.read(), &page.conversation_id, &input.message_id) {
                            p { "{preview}" }
                        }
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
                    }
                }
            }
        }
    }
}
