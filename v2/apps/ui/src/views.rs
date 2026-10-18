use crate::transport::{self, Failure};
use dioxus::prelude::*;
use orkestr_v2_contracts::{Credentials, Project, ProjectInput, Receipt};
use orkestr_v2_ui::{Draft, Projection};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[component]
pub fn Auth(onlogin: EventHandler<transport::BrowserSession>) -> Element {
    let mut username = use_signal(String::new);
    let mut password = use_signal(String::new);
    let mut bootstrap = use_signal(String::new);
    let mut setup = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    rsx! {
        form { onsubmit: move |event| {
            event.prevent_default();
            if busy() { return; }
            busy.set(true);
            spawn(async move {
                let credentials = Credentials { username: username(), password: password() };
                password.set(String::new());
                let secret = bootstrap();
                bootstrap.set(String::new());
                let body = serde_json::to_value(credentials).unwrap_or(Value::Null);
                let result = if setup() {
                    transport::request::<Value>("POST", "/api/v2/setup", body.clone(), "", &secret).await.map(|_| ())
                } else { Ok(()) };
                match result {
                    Err(error) => status.set(error.message),
                    Ok(()) => match transport::request("POST", "/api/v2/browser/session", body, "", "").await {
                        Ok(session) => onlogin.call(session),
                        Err(error) => status.set(error.message),
                    }
                }
                busy.set(false);
            });
        },
            h2 { if setup() { "Create first administrator" } else { "Sign in" } }
            p { "Sign in to your local assistant." }
            label { r#for: "username", "Username" }
            input { id: "username", autocomplete: "username", required: true, value: "{username}", oninput: move |e| username.set(e.value()) }
            label { r#for: "password", "Password" }
            input { id: "password", r#type: "password", autocomplete: if setup() { "new-password" } else { "current-password" }, required: true, value: "{password}", oninput: move |e| password.set(e.value()) }
            if setup() {
                label { r#for: "bootstrap", "Local operator bootstrap token" }
                input { id: "bootstrap", r#type: "password", autocomplete: "off", required: true, value: "{bootstrap}", oninput: move |e| bootstrap.set(e.value()) }
                p { "Use the token configured for this isolated server. Never place it in a URL. Setup is one-time." }
            }
            button { r#type: "submit", disabled: busy(), if busy() { "Connecting…" } else { "Continue" } }
            button { r#type: "button", disabled: busy(), onclick: move |_| setup.set(!setup()), if setup() { "Use existing administrator" } else { "First-time setup" } }
            p { role: "status", "{status}" }
        }
    }
}

#[component]
pub fn Projects(
    csrf: String,
    mut projects: Signal<Vec<Project>>,
    mut pending: Signal<Option<ProjectInput>>,
    onopen: EventHandler<String>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut name = use_signal(move || pending().map(|p| p.name).unwrap_or_default());
    let mut status = use_signal(|| "Loading projects…".to_string());
    let mut busy = use_signal(|| false);
    let load_csrf = csrf.clone();
    use_future(move || {
        let csrf = load_csrf.clone();
        async move {
            match transport::projects(&csrf).await {
                Ok(items) => {
                    projects.set(items);
                    status.set("Local projects".into());
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
        section { h2 { "Projects" }
            p { role: "status", "{status}" }
            ul { for project in projects() {
                li { key: "{project.project_id}",
                    button { onclick: move |_| onopen.call(project.conversation_id.to_string()), "{project.name}" }
                    span { "Git: {project.resources.local_git}; OXRM: {project.resources.local_oxrm}" }
                }
            } }
            form { onsubmit: move |event| {
                event.prevent_default();
                if busy() { return; }
                busy.set(true);
                let csrf = csrf.clone();
                spawn(async move {
                    let result: Result<Project, Failure> = async {
                        let input = if let Some(input) = pending() { input } else {
                            let input = ProjectInput { client_request_id: transport::key().await?, name: name() };
                            if input.name.trim().is_empty() || input.name.len() > 200 { return Err("Project name must contain 1–200 UTF-8 bytes".to_string().into()); }
                            pending.set(Some(input.clone()));
                            input
                        };
                        transport::request("POST", "/api/v2/projects", json!(input), &csrf, "").await
                    }.await;
                    match result {
                        Ok(project) => {
                            pending.set(None);
                            if !projects.read().iter().any(|p| p.project_id == project.project_id) { projects.write().push(project); }
                            name.set(String::new()); status.set("Project created; resources are not yet provisioned.".into());
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
                label { r#for: "project-name", "New local project name" }
                input { id: "project-name", required: true, value: "{name}", disabled: pending().is_some(), oninput: move |e| name.set(e.value()) }
                button { disabled: busy(), if pending().is_some() { "Retry same project request" } else { "Create project" } }
            }
        }
    }
}

#[component]
pub fn Conversation(
    id: String,
    csrf: String,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
) -> Element {
    let execution_id = id.clone();
    let execution = use_signal(move || {
        let mut state = orkestr_v2_ui::execution::Execution::default();
        state.select(&execution_id, "");
        state
    });
    let mut projection = use_signal(Projection::default);
    let mut status = use_signal(|| "Loading history…".to_string());
    let mut sending = use_signal(|| false);
    let stream_id = id.clone();
    let stream_csrf = csrf.clone();
    use_future(move || {
        let id = stream_id.clone();
        let csrf = stream_csrf.clone();
        async move {
            let mut cursor = 0;
            let mut resync = true;
            loop {
                if resync {
                    match transport::snapshot(&id, &csrf, 0, Projection::default(), 0).await {
                        Ok(snapshot) => {
                            cursor = snapshot.watermark;
                            projection.set(snapshot);
                            resync = false;
                            status.set("History synchronized. Waiting for accepted input.".into());
                        }
                        Err(error) => {
                            if error.status == 401 {
                                onexpired.call(());
                                return;
                            }
                            status.set(error.message);
                            transport::delay().await;
                            continue;
                        }
                    }
                }
                match transport::event(&id, cursor).await {
                    Ok(item) if item.status == 401 || item.event == "session_expired" => {
                        onexpired.call(());
                        return;
                    }
                    Ok(item) if item.status == 409 || item.event == "resync_required" => {
                        resync = true;
                        status.set("Cursor requires history resync.".into());
                    }
                    Ok(item)
                        if item.event == "message_accepted"
                            || item.event == "fixture_provider_observed"
                            || item.event == "fixture_cancellation_requested"
                            || item.event == "fixture_provider_stopped" =>
                    {
                        let previous = projection.read().clone();
                        let sequence = item.body.as_ref().and_then(|event| {
                            orkestr_v2_ui::replay_sequence(
                                &previous,
                                &item.event,
                                item.id.as_deref(),
                                event,
                            )
                            .ok()
                        });
                        match sequence {
                            None => {
                                resync = true;
                                status.set("History changed unexpectedly. Reloading…".into());
                            }
                            Some(sequence) if sequence > cursor => {
                                match transport::snapshot(&id, &csrf, cursor, previous, sequence)
                                    .await
                                {
                                    Ok(snapshot) if snapshot.watermark >= sequence => {
                                        cursor = snapshot.watermark;
                                        projection.set(snapshot);
                                        status.set(
                                            orkestr_v2_ui::replay_notice(
                                                item.body.as_ref().expect("validated event body"),
                                            )
                                            .into(),
                                        );
                                    }
                                    Ok(_) => {
                                        resync = true;
                                        status.set("Snapshot has not reached journal event; resync required.".into());
                                    }
                                    Err(error) => {
                                        if error.status == 401 {
                                            onexpired.call(());
                                            return;
                                        }
                                        status.set(error.message);
                                    }
                                }
                            }
                            Some(_) => {}
                        }
                    }
                    Ok(_) => status.set(
                        "Stream disconnected; reconnecting. Runtime status unavailable.".into(),
                    ),
                    Err(error) => status.set(error.message),
                }
                transport::delay().await;
            }
        }
    });
    let draft = drafts.read().get(&id).cloned().unwrap_or_default();
    let input_id = id.clone();
    let submit_id = id.clone();
    rsx! {
        section { "aria-label": "Conversation",
            p { role: "status", "{status}" }
            p { "Latest 100 messages displayed; history is fetched in pages. Reload preserves server history, but unsent drafts live only in this page." }
            ol { class: "messages", "aria-live": "off",
                for message in projection.read().messages.values() {
                    li { key: "{message.message_id}", strong { "{message.actor_kind}" } p { "{message.text}" } }
                }
            }
            crate::execution_panel::ExecutionPanel { execution, now_ms: 0 }
            form { onsubmit: move |event| {
                event.prevent_default();
                if sending() { return; }
                sending.set(true);
                let id = submit_id.clone();
                let csrf = csrf.clone();
                spawn(async move {
                    let result: Result<Receipt, Failure> = async {
                        let key = transport::key().await?;
                        let input = drafts.write().entry(id.clone()).or_default().prepare(key).map_err(|m| Failure::from(m.to_string()))?;
                        transport::request("POST", &format!("/api/v2/conversations/{id}/messages"), json!(input), &csrf, "").await
                    }.await;
                    match result {
                        Ok(receipt) => {
                            drafts.write().entry(id).or_default().accepted();
                            status.set(format!("Input durably accepted at sequence {}. No model result is implied.", receipt.sequence));
                        }
                        Err(error) => {
                            if error.status == 401 { onexpired.call(()); }
                            if matches!(error.status, 400 | 403 | 404 | 409 | 422) {
                                drafts.write().entry(id).or_default().pending = None;
                            }
                            status.set(error.message);
                        }
                    }
                    sending.set(false);
                });
            },
                label { r#for: "composer", "Message" }
                textarea { id: "composer", rows: 4, value: "{draft.text}", "aria-describedby": "composer-help",
                    oninput: move |event| drafts.write().entry(input_id.clone()).or_default().edit(event.value())
                }
                p { id: "composer-help", "Enter inserts a newline. Use Send to submit. You can keep editing while awaiting receipt." }
                button { r#type: "submit", disabled: sending(), if draft.pending.is_some() { "Retry pending input" } else { "Send" } }
            }
        }
    }
}
