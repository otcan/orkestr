use crate::transport;
use dioxus::prelude::*;
use orkestr_v2_contracts::Credentials;
use orkestr_v2_ui::{session_scope::SessionScope, Draft, Projection};
use serde_json::Value;
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
            h2 { if setup() { "Create owner account" } else { "Sign in" } }
            p { "Sign in to your local assistant." }
            label { r#for: "username", "Username" }
            input { id: "username", autocomplete: "username", required: true, value: "{username}", oninput: move |e| username.set(e.value()) }
            label { r#for: "password", "Password" }
            input { id: "password", r#type: "password", autocomplete: if setup() { "new-password" } else { "current-password" }, required: true, value: "{password}", oninput: move |e| password.set(e.value()) }
            if setup() {
                label { r#for: "bootstrap", "Local operator bootstrap token" }
                input { id: "bootstrap", r#type: "password", autocomplete: "off", required: true, value: "{bootstrap}", oninput: move |e| bootstrap.set(e.value()) }
                p { "Use the setup token provided by your operator. Keep it private. Setup creates the first owner account once." }
            }
            button { r#type: "submit", disabled: busy(), if busy() { "Connecting…" } else { "Continue" } }
            button { r#type: "button", disabled: busy(), onclick: move |_| setup.set(!setup()), if setup() { "Use existing owner account" } else { "First-time setup" } }
            p { role: "status", "{status}" }
        }
    }
}

#[component]
pub fn Conversation(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut projection = use_signal(Projection::default);
    let mut status = use_signal(|| "Loading history…".to_string());
    let mut accepted_revision = use_signal(|| 0_i64);
    let stream_id = id.clone();
    let stream_csrf = csrf.clone();
    use_future(move || {
        let id = stream_id.clone();
        let csrf = stream_csrf.clone();
        async move {
            let mut cursor = 0;
            let mut resync = true;
            loop {
                if !session_scope.read().is_current(generation) {
                    projection.set(Projection::default());
                    return;
                }
                if resync {
                    let result = transport::snapshot(&id, &csrf, 0, Projection::default(), 0).await;
                    if !session_scope.read().is_current(generation) {
                        projection.set(Projection::default());
                        return;
                    }
                    match result {
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
                let result = transport::event(&id, cursor).await;
                if !session_scope.read().is_current(generation) {
                    projection.set(Projection::default());
                    return;
                }
                match result {
                    Ok(item) if item.status == 401 || item.event == "session_expired" => {
                        onexpired.call(());
                        return;
                    }
                    Ok(item) if item.status == 409 || item.event == "resync_required" => {
                        resync = true;
                        status.set("Cursor requires history resync.".into());
                    }
                    Ok(item) if orkestr_v2_ui::is_replay_item(&item) => {
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
                                let result =
                                    transport::snapshot(&id, &csrf, cursor, previous, sequence)
                                        .await;
                                if !session_scope.read().is_current(generation) {
                                    projection.set(Projection::default());
                                    return;
                                }
                                match result {
                                    Ok(snapshot) if snapshot.watermark >= sequence => {
                                        cursor = snapshot.watermark;
                                        projection.set(snapshot);
                                        if let Some(event) = item.body.as_ref() {
                                            execution.write().acceptances.observe(event);
                                            if matches!(event, orkestr_v2_contracts::ConversationEvent::ExecutionAccepted(_)) {
                                                accepted_revision.set(sequence);
                                            }
                                        }
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
    let now = use_signal(|| 0_u64);
    let messages = projection
        .read()
        .messages
        .values()
        .map(orkestr_v2_ui::chat_timeline::Input::from)
        .collect::<Vec<_>>();
    let live_status = execution
        .read()
        .control_status()
        .filter(|s| s.conversation_id.to_string() == id);
    rsx! {
        section { class: "conversation-pane", "aria-label": "Conversation",
            crate::execution_poll::ExecutionPoll { key: "{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, execution, worker_tasks: false, headless: true, clock: Some(now), onexpired }
            div { class: "conversation-scroll", tabindex: "0", "aria-label": "Conversation transcript",
                crate::intelligence_view::IntelligencePanel { key:"intelligence-{id}-{generation}", id:id.clone(), csrf:csrf.clone(), session_scope, execution, onexpired, onaccepted:move |revision|accepted_revision.set(revision) }
                crate::accepted_results_view::AcceptedReplies { key: "accepted-{id}-{generation}", id: id.clone(), session_scope, messages, update: Some(accepted_revision), inline: true, onexpired }
                if let Some(current) = live_status.filter(|s| s.progress.is_some() && s.phase != orkestr_v2_contracts::ExecutionPhase::Completed) {
                    article { class: "assistant-proposal",
                        h3 { "Assistant" }
                        crate::progress_view::ProgressView { key: "{current.conversation_id}/{current.progress.as_ref().unwrap().payload_id}", status: current, csrf: csrf.clone(), execution, session_scope, onexpired }
                    }
                }
                details { class: "conversation-tools",
                    summary { "Files and held inputs" }
                    crate::attachments_view::ThreadFiles { key: "files-{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, onexpired }
                    crate::held_inputs_poll::HeldInputsPanel { key: "held-{id}-{generation}", id: id.clone(), session_scope, model: held_inputs, projection, onexpired }
                }
                details { class: "conversation-tools",
                    summary { "Connection and work details" }
                    crate::beta_window_view::WindowView { key: "window-{id}-{generation}", id:id.clone(), session_scope, onexpired }
                    p { "{status}" }
                    p { "Latest 100 saved inputs. History has earlier pages. Unsent drafts remain in this page." }
                }
            }
            div { class: "composer-dock",
                crate::execution_panel::ExecutionPanel { execution, now_ms: now(), parent_tasks: false, csrf: csrf.clone(), session_scope, onexpired, compact: true, onaccepted: Some(EventHandler::new(move |revision| accepted_revision.set(revision))) }
                crate::composer::Composer { key: "composer-{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, drafts, onexpired }
            }
        }
    }
}
