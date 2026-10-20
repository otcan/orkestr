use crate::{
    beta_bridge, send_admission,
    transport::{self, Failure},
};
use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, Receipt};
use orkestr_v2_ui::{
    beta_inputs::{SavedInput, SavedInputs},
    beta_window::WindowIntents,
    send_intent,
    session_scope::SessionScope,
    Draft,
};
use serde_json::json;
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

#[component]
pub fn Composer(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut saved = use_context::<Signal<SavedInputs>>();
    let mut intents = use_context::<Signal<WindowIntents>>();
    let mut sending = use_signal(|| false);
    let mut status = use_signal(String::new);
    let channel = use_signal(|| None::<document::Eval>);
    let live = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = live.clone();
    use_drop(move || {
        dropped.set(false);
        beta_bridge::stop(*channel.peek());
    });
    let draft = drafts.read().get(&id).cloned().unwrap_or_default();
    let retained = draft
        .pending
        .as_ref()
        .and_then(|p| saved.read().request(&id, &p.input.client_message_id));
    let review = intents.read().refused(&id);
    let full = saved.read().is_full() && retained.is_none();
    let input_id = id.clone();
    rsx! {
        form { class: "message-composer", onsubmit: move |event| {
            event.prevent_default();
            if sending() || !live.get() || !session_scope.read().is_current(owner) { return; }
            sending.set(true);
            status.set("Sending…".into());
            let id = id.clone(); let csrf = csrf.clone(); let live = live.clone();
            spawn(async move {
                let current = || live.get() && session_scope.read().is_current(owner);
                let result: Result<Option<String>, Failure> = async {
                    let key = transport::key().await?;
                    if !current() { return Err("Conversation changed.".to_string().into()); }
                    let input = drafts.write().entry(id.clone()).or_default().prepare(key).map_err(|m| Failure::from(m.to_string()))?;
                    let retained = saved.read().request(&id, &input.client_message_id);
                    let input = if let Some(retained) = retained { retained } else {
                        if saved.read().is_full() { return Err("Finish the pending sends before sending another message.".to_string().into()); }
                        let response: Result<Receipt, Failure> = transport::request("POST", &format!("/api/v2/conversations/{id}/messages"), json!(input), &csrf, "").await;
                        if !current() { return Err("Conversation changed. The original send can be retried there.".to_string().into()); }
                        let receipt = match response {
                            Ok(receipt) => receipt,
                            Err(error) => {
                                if matches!(error.status,400|403|404|409|422) { drafts.write().entry(id.clone()).or_default().pending=None; }
                                return Err(error);
                            }
                        };
                        let conversation: ConversationId = serde_json::from_value(json!(id)).map_err(|_| Failure::from("Conversation could not be verified.".to_string()))?;
                        let saved_input = SavedInput { conversation, input_request_key:input.client_message_id, receipt };
                        if !saved.write().retain_receipt(saved_input.clone()) { return Err("Message saved, but its receipt could not be verified. Retry keeps the original message.".to_string().into()); }
                        saved_input
                    };
                    // Only a new, explicit Send gesture may review a definitive refusal.
                    // An unknown response retains its exact original admission tuple.
                    if intents.read().refused(&id) {
                        let same = intents.read().pending(&id).is_some_and(|r|send_intent::same_input(r,&input));
                        let ticket = intents.read().ticket(&id);
                        if !same || !ticket.is_some_and(|ticket|intents.write().review_refusal(&id,&ticket)) { return Err("Another send needs review in this conversation.".to_string().into()); }
                    }
                    status.set("Starting…".into());
                    send_admission::admit(input,csrf,send_admission::SendScope { session:session_scope,owner,live:live.clone(),intents,saved,channel }).await
                }.await;
                if !current() { return; }
                match result {
                    Ok(queued) => { drafts.write().entry(id).or_default().accepted(); status.set(queued.unwrap_or_else(|| "Sent. Waiting for a reply.".into())); }
                    Err(error) => { if error.status==401 { onexpired.call(()); } status.set(error.message); }
                }
                sending.set(false);
            });
        },
            label { r#for: "composer", "Message" }
            textarea { id: "composer", rows: 3, value: "{draft.text}", "aria-describedby": "composer-help",
                oninput: move |event| { if session_scope.read().is_current(owner) { drafts.write().entry(input_id.clone()).or_default().edit(event.value()); } }
            }
            p { id: "composer-help", if retained.is_some() && !sending() { "Message saved; work has not started yet. Retry send to start it. Your newer edits stay in the composer." } else if draft.pending.is_some() { "Retry sends the original message. Your newer edits stay in the composer." } else { "Send starts work. Enter adds a new line." } }
            button { r#type: "submit", disabled: sending() || full, if review { "Review and retry send" } else if draft.pending.is_some() { "Retry send" } else { "Send" } }
            if !status().is_empty() { p { class: "composer-notice", role: "status", "{status}" } }
        }
    }
}
