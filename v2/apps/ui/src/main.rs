mod about;
mod acceptance_button;
mod attachments_view;
mod beta_settings;
mod execution_panel;
mod execution_poll;
mod fast_panel;
mod held_inputs_poll;
mod held_inputs_view;
mod history;
mod host_resources_view;
mod progress_view;
mod steering_view;
mod stop_button;
mod transport;
mod views;
mod worker_tasks_panel;
mod worker_tasks_view;
use dioxus::prelude::*;
use orkestr_v2_ui::{session_scope::SessionScope, Draft};
use serde_json::Value;
use std::collections::BTreeMap;

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let mut csrf = use_signal(String::new);
    let mut global = use_signal(String::new);
    let mut current = use_signal(String::new);
    let mut drafts = use_signal(BTreeMap::<String, Draft>::new);
    let mut session_scope = use_signal(SessionScope::default);
    let mut task_drafts = use_signal(|| {
        orkestr_v2_ui::task_draft_lifetime::TaskDrafts::new(dioxus::dioxus_core::current_scope_id())
    });
    use_context_provider(move || task_drafts);
    // Owner-scoped high-water marks outlive keyed conversation and tab remounts.
    let mut execution = use_signal(orkestr_v2_ui::execution::Execution::default);
    let mut host_resources = use_signal(orkestr_v2_ui::host_resources::HostResources::default);
    let mut held_inputs = use_signal(orkestr_v2_ui::held_inputs::HeldInputs::default);
    let mut tab = use_signal(|| "Assistant".to_string());
    let mut notice = use_signal(|| "Sign in to your local server.".to_string());
    let mut refresh = use_signal(|| 0_u64);
    let mut resuming = use_signal(|| true);
    let mut logging_out = use_signal(|| false);
    use_future(move || async move {
        match transport::request::<transport::BrowserSession>(
            "GET",
            "/api/v2/browser/session",
            Value::Null,
            "",
            "",
        )
        .await
        {
            Ok(session) => {
                execution.write().authorization_lost();
                host_resources.write().clear_owner();
                held_inputs.write().clear_owner();
                task_drafts.write().clear_owner();
                session_scope
                    .write()
                    .activate(&session.global_conversation_id, &mut drafts.write());
                task_drafts
                    .write()
                    .activate(session_scope.read().generation());
                global.set(session.global_conversation_id.clone());
                current.set(session.global_conversation_id);
                csrf.set(session.csrf_token);
                notice.set("Signed in.".into());
            }
            Err(error) => {
                if error.status != 401 {
                    notice.set(error.message);
                }
            }
        }
        resuming.set(false);
    });
    let mut expired = move |_| {
        execution.write().authorization_lost();
        host_resources.write().clear_owner();
        held_inputs.write().clear_owner();
        task_drafts.write().clear_owner();
        session_scope.write().invalidate();
        global.set(String::new());
        current.set(String::new());
        refresh += 1;
        csrf.set(String::new());
        notice.set("Session expired. Sign in again; unsent drafts remain in this page.".into());
    };
    rsx! {
        style { "{include_str!(\"style.css\")}" }
        main {
            header { h1 { "Orkestr" } p { "Codex Deep · beta" } }
            p { class: "notice", "One conversation with Codex Deep. Review each proposed result before accepting it. Stop remains available only for the current connected run." }
            p { role: "status", "{notice}" }
            if resuming() {
                p { role: "status", "Checking browser session…" }
            } else if logging_out() && csrf().is_empty() {
                p { role: "status", "Finishing sign-out before another sign-in…" }
            } else if csrf().is_empty() {
                views::Auth { onlogin: move |session: transport::BrowserSession| {
                    if logging_out() { return; }
                    execution.write().authorization_lost();
                        host_resources.write().clear_owner();
                        held_inputs.write().clear_owner();
                        task_drafts.write().clear_owner();
                    session_scope.write().activate(&session.global_conversation_id, &mut drafts.write());
                    task_drafts.write().activate(session_scope.read().generation());
                    refresh += 1;
                    tab.set("Assistant".into());
                    global.set(session.global_conversation_id.to_string());
                    current.set(session.global_conversation_id.to_string());
                    csrf.set(session.csrf_token);
                    notice.set("Signed in.".into());
                } }
            } else {
                nav { "aria-label": "Main",
                    for name in ["Assistant", "History", "Host resources", "Settings"] {
                        button { "aria-current": if tab() == name { "page" } else { "false" }, onclick: move |_| {
                            tab.set(name.into());
                            if name == "Assistant" { current.set(global()); }
                        }, "{name}" }
                    }
                    button { disabled: logging_out(), onclick: move |_| {
                        if logging_out() { return; }
                        logging_out.set(true);
                        let secret = csrf();
                        let generation = session_scope.read().generation();
                        spawn(async move {
                            let result = transport::request::<Value>("DELETE", "/api/v2/browser/session", Value::Null, &secret, "").await;
                            if !session_scope.read().is_current(generation) { logging_out.set(false); return; }
                            match result {
                                Ok(_) => {
                                    execution.write().authorization_lost();
                                                        host_resources.write().clear_owner();
                                                        held_inputs.write().clear_owner();
                                                        task_drafts.write().clear_owner();
                                    session_scope.write().invalidate();
                                    global.set(String::new()); current.set(String::new()); refresh += 1;
                                    csrf.set(String::new());
                                    notice.set("Signed out. Server session revoked; unsent drafts remain in this page.".into());
                                }
                                Err(error) if error.status == 401 => expired(()),
                                Err(error) => notice.set(format!("Sign-out not confirmed. {}", error.message)),
                            }
                            logging_out.set(false);
                        });
                    }, if logging_out() { "Signing out…" } else { "Sign out" } }
                }
                if tab() == "Assistant" {
                    section { key: "{current()}-{refresh}",
                    h2 { "Assistant" }
                    button { onclick: move |_| refresh += 1, "Reconnect and reload history" }
                    views::Conversation { id: current(), csrf: csrf(), session_scope, execution, drafts, held_inputs, onexpired: expired }
                    }
                } else if tab() == "History" {
                    history::History { key: "{current()}", id: current(), csrf: csrf(), session_scope, onexpired: expired }
                } else if tab() == "Host resources" {
                    host_resources_view::HostResourcesView { key: "{session_scope.read().generation()}", session_scope, resources: host_resources, onexpired: expired }
                } else {
                    beta_settings::BetaSettings {}
                }
            }
        }
    }
}
