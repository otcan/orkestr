use crate::transport::{self, Failure};
use dioxus::prelude::*;
use orkestr_v2_contracts::{Credentials, Receipt};
use orkestr_v2_ui::{session_scope::SessionScope, Draft, Projection};
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
    mut drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut saved_inputs = use_context::<Signal<orkestr_v2_ui::beta_inputs::SavedInputs>>();
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
            crate::attachments_view::ThreadFiles { key: "files-{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, onexpired }
            crate::held_inputs_poll::HeldInputsPanel { id: id.clone(), session_scope, model: held_inputs, projection, onexpired }
            crate::execution_poll::ExecutionPoll { key: "{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, execution, worker_tasks: false, onexpired }
            form { onsubmit: move |event| {
                event.prevent_default();
                if sending() || !session_scope.read().is_current(generation) { return; }
                sending.set(true);
                let id = submit_id.clone();
                let csrf = csrf.clone();
                spawn(async move {
                    let result: Result<(Receipt, String), Failure> = async {
                        let key = transport::key().await?;
                        if !session_scope.read().is_current(generation) { return Err("Session changed".to_string().into()); }
                        let input = drafts.write().entry(id.clone()).or_default().prepare(key).map_err(|m| Failure::from(m.to_string()))?;
                        let input_key = input.client_message_id.clone();
                        transport::request("POST", &format!("/api/v2/conversations/{id}/messages"), json!(input), &csrf, "").await.map(|receipt| (receipt, input_key))
                    }.await;
                    if !session_scope.read().is_current(generation) { return; }
                    match result {
                        Ok((receipt, input_request_key)) => {
                            let Ok(conversation) = serde_json::from_value(serde_json::Value::String(id.clone())) else { status.set("Saved input needs a history reload.".into()); sending.set(false); return; };
                            if !saved_inputs.write().retain_receipt(orkestr_v2_ui::beta_inputs::SavedInput { conversation, input_request_key, receipt: receipt.clone() }) {
                                status.set("Input saved, but its admission receipt needs review. Keep this page open and reload history.".into()); sending.set(false); return;
                            }
                            drafts.write().entry(id).or_default().accepted();
                            status.set(format!("Input durably accepted at sequence {}. Choose Start or Add to current work to admit it. No work has started from this receipt.", receipt.sequence));
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
                    oninput: move |event| { if session_scope.read().is_current(generation) { drafts.write().entry(input_id.clone()).or_default().edit(event.value()); } }
                }
                p { id: "composer-help", "Enter inserts a newline. Use Send to submit. You can keep editing while awaiting receipt." }
                button { r#type: "submit", disabled: sending() || saved_inputs.read().is_full(), if draft.pending.is_some() { "Retry pending input" } else { "Send" } }
            }
        }
    }
}
