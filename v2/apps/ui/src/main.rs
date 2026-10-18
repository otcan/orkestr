mod transport;
mod views;
mod history;
use dioxus::prelude::*;
use orkestr_v2_contracts::{Project, ProjectInput};
use orkestr_v2_ui::Draft;
use std::collections::BTreeMap;

fn main() { dioxus::launch(App); }

#[component]
fn App() -> Element {
    let mut token = use_signal(String::new);
    let mut global = use_signal(String::new);
    let mut current = use_signal(String::new);
    let mut projects = use_signal(Vec::<Project>::new);
    let drafts = use_signal(BTreeMap::<String, Draft>::new);
    let pending_project = use_signal(|| None::<ProjectInput>);
    let mut tab = use_signal(|| "Assistant".to_string());
    let mut notice = use_signal(|| "Sign in to your local server.".to_string());
    let mut refresh = use_signal(|| 0_u64);
    let expired = move |_| {
        token.set(String::new());
        notice.set("Session expired. Sign in again; unsent drafts remain in this page.".into());
    };
    rsx! {
        style { "{include_str!(\"style.css\")}" }
        main {
            header { h1 { "Orkestr" } p { "Local assistant · durable intake" } }
            p { class: "notice", "Intake only: models, runs, Stop, approvals and memory are unavailable. Local Git is not provisioned; OXRM is unverified." }
            p { role: "status", "{notice}" }
            if token().is_empty() {
                views::Auth { onlogin: move |session: orkestr_v2_contracts::SessionResponse| {
                    global.set(session.global_conversation_id.to_string());
                    current.set(session.global_conversation_id.to_string());
                    token.set(session.token);
                    notice.set("Signed in. Token is held in memory; reload requires sign-in.".into());
                } }
            } else {
                nav { "aria-label": "Main",
                    for name in ["Assistant", "Projects", "Attention", "History", "Settings"] {
                        button { "aria-current": if tab() == name { "page" } else { "false" }, onclick: move |_| {
                            tab.set(name.into());
                            if name == "Assistant" { current.set(global()); }
                        }, "{name}" }
                    }
                    button { onclick: move |_| {
                        token.set(String::new());
                        notice.set("Token forgotten locally. Server-side revocation is unavailable; token expires within 12 hours. Drafts stay in this page.".into());
                    }, "Forget local sign-in" }
                }
                if tab() == "Projects" {
                    views::Projects { token: token(), projects, pending: pending_project, onexpired: expired,
                        onopen: move |id: String| { current.set(id); tab.set("Assistant".into()); }
                    }
                } else if tab() == "Assistant" {
                    h2 { if current() == global() { "Assistant" } else { "Project conversation" } }
                    if current() != global() {
                        for project in projects().iter().filter(|p| p.conversation_id.to_string() == current()) {
                            p { "{project.name} · Git: {project.resources.local_git} · OXRM: {project.resources.local_oxrm}" }
                        }
                    }
                    button { onclick: move |_| refresh += 1, "Reconnect and reload history" }
                    views::Conversation { key: "{current()}-{refresh}", id: current(), token: token(), drafts, onexpired: expired }
                } else if tab() == "History" {
                    history::History { key: "{current()}", id: current(), token: token(), onexpired: expired }
                } else if tab() == "Attention" {
                    p { "Approvals, blockers and task attention are unavailable. No pending-work count is inferred." }
                } else {
                    p { "Server API v0. Provider setup, device auth, revocation and opt-in memory controls are unavailable. Optional external integrations are not required." }
                }
            }
        }
    }
}
