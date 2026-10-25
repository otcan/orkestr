use dioxus::prelude::*;

#[component]
pub fn BetaSettings() -> Element {
    rsx! {
        section { "aria-label": "Beta settings",
            h2 { "Settings" }
            p { "Create separate conversations for separate work. Select a conversation to read it; starting work is a separate action." }
            p { "Messages, history and saved files stay on your server. Unsent drafts stay in this page; save or send them before closing it." }
            p { "Accept a proposed result only after reviewing it. Requesting Stop does not confirm that work has stopped." }
            p { "Provider configuration is managed by your operator. Available intelligence layers are reported by your server and share the current work window." }
            p { "Available tools depend on your operator's provider configuration. Review the configured workspace and access before starting work." }
            crate::about::About {}
        }
    }
}
