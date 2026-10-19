use crate::transport::{self, Failure};
use dioxus::prelude::*;
use orkestr_v2_contracts::Receipt;
use orkestr_v2_ui::{session_scope::SessionScope, Draft};
use serde_json::json;
use std::collections::BTreeMap;

#[component]
pub fn Composer(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut saved_inputs = use_context::<Signal<orkestr_v2_ui::beta_inputs::SavedInputs>>();
    let mut sending = use_signal(|| false);
    let mut status = use_signal(String::new);
    let draft = drafts.read().get(&id).cloned().unwrap_or_default();
    let input_id = id.clone();
    let submit_id = id;
    rsx! {
            form { class: "message-composer", onsubmit: move |event| {
                event.prevent_default();
                if sending() || !session_scope.read().is_current(generation) { return; }
                sending.set(true);
                status.set("Saving message…".into());
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
                            status.set("Message saved. Choose Start work or Add to current work.".into());
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
                textarea { id: "composer", rows: 3, value: "{draft.text}", "aria-describedby": "composer-help",
                    oninput: move |event| { if session_scope.read().is_current(generation) { drafts.write().entry(input_id.clone()).or_default().edit(event.value()); } }
                }
                p { id: "composer-help", "Enter for a new line. Send saves your message; Start work admits it." }
                button { r#type: "submit", disabled: sending() || saved_inputs.read().is_full(), if draft.pending.is_some() { "Retry pending input" } else { "Send" } }
                if !status().is_empty() { p { class: "composer-notice", role: "status", "{status}" } }
            }
    }
}
