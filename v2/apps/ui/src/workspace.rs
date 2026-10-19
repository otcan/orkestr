use dioxus::prelude::*;
use orkestr_v2_ui::{session_scope::SessionScope, Draft};
use std::collections::BTreeMap;

/// Navigation changes presentation only. Work admission remains an explicit action.
#[component]
pub fn Workspace(
    mut current: Signal<String>,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    resources: Signal<orkestr_v2_ui::host_resources::HostResources>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut title = use_signal(|| "Assistant".to_string());
    let mut tab = use_signal(|| "Chat".to_string());
    let mut sidebar = use_signal(|| false);
    let mut reload = use_signal(|| 0_u64);
    rsx! {
        div { class: "workspace", "data-sidebar-open": "{sidebar}",
            crate::conversation_sidebar::ConversationSidebar {
                selected: current(), csrf: csrf.clone(), session_scope, onexpired,
                onselect: move |row: orkestr_v2_ui::conversation_directory::ConversationSummary| {
                    let id = row.conversation_id.to_string();
                    // Fence a late control response before the new keyed reader mounts.
                    execution.write().select(&id, "");
                    current.set(id);
                    title.set(row.name);
                    tab.set("Chat".into());
                    sidebar.set(false);
                    reload += 1;
                }
            }
            div { class: "workspace-main",
                header { class: "conversation-heading",
                    button { class: "threads-toggle", "aria-expanded": "{sidebar}", onclick: move |_| sidebar.set(!sidebar()), "Conversations" }
                    h2 { "{title}" }
                    nav { "aria-label": "Main",
                        for name in ["Chat", "History", "Host resources", "Settings"] {
                            button { "aria-current": if tab() == name { "page" } else { "false" }, onclick: move |_| {
                                if tab() == name { return; }
                                execution.write().select(&current(), "");
                                tab.set(name.into());
                            }, "{name}" }
                        }
                    }
                }
                if tab() == "Chat" {
                    SelectedConversation {
                        key: "{current()}-{session_scope.read().generation()}-{reload}",
                        id: current(), csrf, session_scope, execution, drafts, held_inputs, onexpired
                    }
                } else {
                    div { class: "workspace-page",
                        if tab() == "History" {
                            crate::history::History { key: "{current()}", id: current(), csrf, session_scope, onexpired }
                        } else if tab() == "Host resources" {
                            crate::host_resources_view::HostResourcesView { session_scope, resources, onexpired }
                        } else {
                            crate::beta_settings::BetaSettings {}
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn SelectedConversation(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut ready = use_signal(|| false);
    let mut retry = use_signal(|| 0_u64);
    rsx! {
        if ready() {
            crate::views::Conversation { id, csrf, session_scope, execution, drafts, held_inputs, onexpired }
        } else {
            div { class: "conversation-loading",
                crate::beta_discovery::BetaDiscoveryGate {
                    key: "{retry}", conversation: Some(id), session_scope, onexpired,
                    onready: move |_| ready.set(true)
                }
                button { onclick: move |_| retry += 1, "Check conversation again" }
            }
        }
    }
}
