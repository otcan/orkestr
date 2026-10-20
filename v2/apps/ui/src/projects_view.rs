use crate::transport::{self, Failure};
use dioxus::prelude::*;
use orkestr_v2_contracts::{Project, ProjectInput, ProjectPage};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::{json, Value};

/// Local projects: each owns one conversation. Creating a project provisions no
/// external resource; opening one only selects its conversation.
#[component]
pub fn Projects(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onopen: EventHandler<(String, String)>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut projects = use_signal(Vec::<Project>::new);
    let mut pending = use_signal(|| None::<ProjectInput>);
    let mut name = use_signal(String::new);
    let mut status = use_signal(|| "Loading projects…".to_string());
    let mut busy = use_signal(|| false);
    let load_csrf = csrf.clone();
    use_future(move || {
        let csrf = load_csrf.clone();
        async move {
            let result: Result<ProjectPage, Failure> =
                transport::request("GET", "/api/v2/projects", Value::Null, &csrf, "").await;
            if !session_scope.read().is_current(generation) {
                return;
            }
            match result {
                Ok(page) => {
                    status.set(if page.projects.is_empty() {
                        "No projects yet.".into()
                    } else {
                        String::new()
                    });
                    projects.set(page.projects);
                }
                Err(error) => {
                    if error.status == 401 {
                        onexpired.call(());
                    }
                    status.set(error.message);
                }
            }
        }
    });
    rsx! {
        section { class: "projects-view", "aria-label": "Projects",
            h2 { "Projects" }
            p { "Each project has its own conversation. Git and OXRM resources show their readiness; creating a project connects nothing external." }
            if !status().is_empty() { p { role: "status", "{status}" } }
            ul { class: "project-list",
                for project in projects() {
                    li { key: "{project.project_id}",
                        button { onclick: { let open = (project.conversation_id.to_string(), project.name.clone()); move |_| onopen.call(open.clone()) }, "{project.name}" }
                        span { "Git: {project.resources.local_git} · OXRM: {project.resources.local_oxrm}" }
                    }
                }
            }
            form { onsubmit: move |event| {
                event.prevent_default();
                if busy() || !session_scope.read().is_current(generation) { return; }
                busy.set(true);
                let csrf = csrf.clone();
                spawn(async move {
                    let result: Result<Project, Failure> = async {
                        let input = if let Some(input) = pending() { input } else {
                            let key = transport::key().await?;
                            let input = ProjectInput { client_request_id: key, name: name().trim().to_string() };
                            if input.name.is_empty() || input.name.len() > 200 { return Err("Project name must contain 1–200 UTF-8 bytes.".to_string().into()); }
                            pending.set(Some(input.clone()));
                            input
                        };
                        transport::request("POST", "/api/v2/projects", json!(input), &csrf, "").await
                    }.await;
                    if !session_scope.read().is_current(generation) { return; }
                    match result {
                        Ok(project) => {
                            pending.set(None);
                            name.set(String::new());
                            if !projects.read().iter().any(|p| p.project_id == project.project_id) { projects.write().push(project); }
                            status.set("Project created.".into());
                        }
                        Err(error) => {
                            if error.status == 401 { onexpired.call(()); }
                            if matches!(error.status, 400 | 403 | 404 | 409 | 422) { pending.set(None); }
                            status.set(error.message);
                        }
                    }
                    busy.set(false);
                });
            },
                label { r#for: "project-name", "New project name" }
                input { id: "project-name", required: true, value: "{name}", disabled: pending().is_some(), oninput: move |e| name.set(e.value()) }
                button { disabled: busy(), if pending().is_some() { "Retry same project request" } else { "Create project" } }
            }
        }
    }
}
