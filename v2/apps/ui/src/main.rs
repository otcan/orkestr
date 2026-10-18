mod execution_panel;
mod history;
mod transport;
mod views;
use dioxus::prelude::*;
use orkestr_v2_contracts::{Project, ProjectInput};
use orkestr_v2_ui::Draft;
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
    let projects = use_signal(Vec::<Project>::new);
    let drafts = use_signal(BTreeMap::<String, Draft>::new);
    let pending_project = use_signal(|| None::<ProjectInput>);
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
                global.set(session.global_conversation_id.clone());
                current.set(session.global_conversation_id);
                csrf.set(session.csrf_token);
                notice
                    .set("Session resumed. Browser integration validation remains pending.".into());
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
        csrf.set(String::new());
        notice.set("Session expired. Sign in again; unsent drafts remain in this page.".into());
    };
    rsx! {
        style { "{include_str!(\"style.css\")}" }
        main {
            header { h1 { "Orkestr" } p { "Local assistant · durable intake" } }
            p { class: "notice", "Browser cookie/CSRF client source. Independent security review and real browser acceptance remain pending. Native credential storage and device auth are unavailable." }
            p { class: "notice", "Intake only: models, runs, Stop, approvals and memory are unavailable. Local Git is not provisioned; OXRM is unverified." }
            p { role: "status", "{notice}" }
            if resuming() {
                p { role: "status", "Checking browser session…" }
            } else if csrf().is_empty() {
                views::Auth { onlogin: move |session: transport::BrowserSession| {
                    global.set(session.global_conversation_id.to_string());
                    current.set(session.global_conversation_id.to_string());
                    csrf.set(session.csrf_token);
                    notice.set("Browser session created. Browser acceptance and independent security review remain pending.".into());
                } }
            } else {
                nav { "aria-label": "Main",
                    for name in ["Assistant", "Projects", "Attention", "History", "Settings"] {
                        button { "aria-current": if tab() == name { "page" } else { "false" }, onclick: move |_| {
                            tab.set(name.into());
                            if name == "Assistant" { current.set(global()); }
                        }, "{name}" }
                    }
                    button { disabled: logging_out(), onclick: move |_| {
                        if logging_out() { return; }
                        logging_out.set(true);
                        let secret = csrf();
                        spawn(async move {
                            match transport::request::<Value>("DELETE", "/api/v2/browser/session", Value::Null, &secret, "").await {
                                Ok(_) => {
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
                if tab() == "Projects" {
                    views::Projects { csrf: csrf(), projects, pending: pending_project, onexpired: expired,
                        onopen: move |id: String| { current.set(id); tab.set("Assistant".into()); }
                    }
                } else if tab() == "Assistant" {
                    section { key: "{current()}-{refresh}",
                    h2 { if current() == global() { "Assistant" } else { "Project conversation" } }
                    if current() != global() {
                        for project in projects().iter().filter(|p| p.conversation_id.to_string() == current()) {
                            p { "{project.name} · Git: {project.resources.local_git} · OXRM: {project.resources.local_oxrm}" }
                        }
                    }
                    button { onclick: move |_| refresh += 1, "Reconnect and reload history" }
                    views::Conversation { id: current(), csrf: csrf(), drafts, onexpired: expired }
                    }
                } else if tab() == "History" {
                    history::History { key: "{current()}", id: current(), csrf: csrf(), onexpired: expired }
                } else if tab() == "Attention" {
                    p { "Approvals, blockers and task attention are unavailable. No pending-work count is inferred." }
                } else {
                    p { "Server API v0 with browser sessions. Provider setup, device auth and opt-in memory controls are unavailable. Optional external integrations are not required." }
                }
            }
        }
    }
}
