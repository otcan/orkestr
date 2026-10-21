use dioxus::prelude::*;
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope};

/// Separate presentation and retention; Fast still shares the canonical conversation.
#[component]
pub fn FastPanel(
    execution: Signal<Execution>,
    now_ms: u64,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    #[props(default)] onaccepted: Option<EventHandler<i64>>,
    #[props(default)] auto_accept: bool,
) -> Element {
    let model = execution.read();
    rsx! {
        section { "aria-label": "Fast reply",
            h3 { "Fast reply" }
            if let Some(status) = model.control_status() {
                p { role: "status", "{model.summary(now_ms)}" }
                crate::stop_button::StopButton { execution, fast: true, csrf: csrf.clone(), session_scope, onexpired }
                if let Some(progress) = &status.progress {
                    crate::progress_view::ProgressView {
                        key: "fast/{status.conversation_id}/{progress.payload_id}",
                        status: status.clone(), csrf: csrf.clone(), execution, session_scope, onexpired
                    }
                }
                crate::acceptance_button::AcceptanceButton {
                    execution, fast_reply: true, now_ms, csrf, session_scope, onexpired, onaccepted
                }
                if auto_accept {
                    p { "Fast replies in this chat are accepted automatically. Turn on \"Review replies before accepting\" in Settings to review each one." }
                } else {
                    p { "A Fast reply needs your review before it can continue. Accepting it does not complete Deep work or a Worker task." }
                }
            } else {
                p { role: "status", "No Fast reply is available for this conversation yet." }
            }
        }
    }
}
