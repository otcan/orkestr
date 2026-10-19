use dioxus::prelude::*;

#[component]
pub fn BetaSettings() -> Element {
    rsx! {
        section { "aria-label": "Beta settings",
            h2 { "Settings" }
            p { "This beta connects one owner account to one Codex Deep conversation." }
            p { "Messages, history and saved files stay on your server. Unsent drafts stay in this page; save or send them before closing it." }
            p { "Accept a proposed result only after reviewing it. Requesting Stop does not confirm that work has stopped." }
            p { "Provider configuration is managed by your operator. This page does not change accounts or create conversations." }
            crate::about::About {}
        }
    }
}
