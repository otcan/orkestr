//! Edit or delete the owner's own message. The server decides whether it may;
//! these controls are only offered on rows it marked as revisable.
use crate::transport;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    MessageRevisionHistory, MessageRevisionKind, MessageRevisionReceipt, MessageRevisionSource,
};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Idle,
    Editing,
    ConfirmDelete,
}

fn revisions_path(conversation: &str, message_id: &str) -> String {
    format!("/api/v2/conversations/{conversation}/messages/{message_id}/revisions")
}

#[component]
pub fn MessageActions(
    conversation: String,
    message_id: String,
    text: String,
    revision: i64,
    csrf: String,
    onexpired: EventHandler<()>,
) -> Element {
    let mut mode = use_signal(|| Mode::Idle);
    let initial = text.clone();
    let mut draft = use_signal(move || initial);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    // A retry after a lost answer reuses its key, so it cannot apply twice.
    let mut attempt = use_signal(|| None::<(Value, String)>);
    let path = revisions_path(&conversation, &message_id);
    let mut submit = move |kind: MessageRevisionKind, body_text: Option<String>| {
        let path = path.clone();
        let csrf = csrf.clone();
        if busy() {
            return;
        }
        busy.set(true);
        error.set(String::new());
        spawn(async move {
            let payload = json!({"kind": kind, "text": body_text, "expected_revision": revision});
            let saved = attempt
                .peek()
                .as_ref()
                .filter(|(earlier, _)| earlier == &payload)
                .map(|(_, key)| key.clone());
            let key = match saved {
                Some(key) => key,
                None => match transport::key().await {
                    Ok(key) => {
                        attempt.set(Some((payload.clone(), key.clone())));
                        key
                    }
                    Err(failure) => {
                        error.set(failure.message);
                        busy.set(false);
                        return;
                    }
                },
            };
            let mut body = payload;
            body["request_key"] = json!(key);
            if kind == MessageRevisionKind::Delete {
                if let Some(fields) = body.as_object_mut() {
                    fields.remove("text");
                }
            }
            match transport::request::<MessageRevisionReceipt>("POST", &path, body, &csrf, "").await
            {
                Ok(_) => {
                    attempt.set(None);
                    mode.set(Mode::Idle);
                }
                Err(failure) if failure.status == 401 => onexpired.call(()),
                Err(failure) => error.set(failure.message),
            }
            busy.set(false);
        });
    };
    let reset_text = text.clone();
    rsx! {
        match mode() {
            Mode::Idle => rsx! {
                button { r#type: "button", class: "message-action", onclick: move |_| { draft.set(text.clone()); error.set(String::new()); mode.set(Mode::Editing); }, "Edit" }
                button { r#type: "button", class: "message-action", onclick: move |_| { error.set(String::new()); mode.set(Mode::ConfirmDelete); }, "Delete" }
            },
            Mode::Editing => rsx! {
                form { class: "message-edit", onsubmit: move |event| {
                    event.prevent_default();
                    submit(MessageRevisionKind::Edit, Some(draft()));
                },
                    textarea { "aria-label": "Edit your message", rows: "3", value: "{draft}", oninput: move |event| draft.set(event.value()) }
                    div { class: "message-edit-buttons",
                        button { r#type: "submit", disabled: busy() || draft().trim().is_empty(), if busy() { "Saving…" } else { "Save" } }
                        button { r#type: "button", disabled: busy(), onclick: move |_| { draft.set(reset_text.clone()); error.set(String::new()); mode.set(Mode::Idle); }, "Cancel" }
                    }
                }
            },
            Mode::ConfirmDelete => rsx! {
                span { class: "message-delete-confirm",
                    "Delete this message?"
                    button { r#type: "button", class: "message-action", disabled: busy(), onclick: move |_| submit(MessageRevisionKind::Delete, None), if busy() { "Deleting…" } else { "Confirm delete" } }
                    button { r#type: "button", class: "message-action", disabled: busy(), onclick: move |_| mode.set(Mode::Idle), "Keep" }
                }
            },
        }
        if !error().is_empty() { p { class: "message-action-error", role: "alert", "{error}" } }
    }
}

/// The audit record of a changed message, read on request.
#[component]
pub fn RevisionHistory(
    conversation: String,
    message_id: String,
    csrf: String,
    onexpired: EventHandler<()>,
) -> Element {
    let mut history = use_signal(|| None::<MessageRevisionHistory>);
    let mut open = use_signal(|| false);
    let mut error = use_signal(String::new);
    let path = revisions_path(&conversation, &message_id);
    rsx! {
        button { r#type: "button", class: "message-action message-history-toggle", "aria-expanded": "{open}", onclick: move |_| {
            let next = !open();
            open.set(next);
            if !next || history.peek().is_some() { return; }
            let path = path.clone();
            let csrf = csrf.clone();
            spawn(async move {
                match transport::request::<MessageRevisionHistory>("GET", &path, Value::Null, &csrf, "").await {
                    Ok(value) => history.set(Some(value)),
                    Err(failure) if failure.status == 401 => onexpired.call(()),
                    Err(failure) => error.set(failure.message),
                }
            });
        }, "History" }
        if open() {
            if let Some(record) = history() {
                ol { class: "message-history",
                    li { key: "original", span { class: "message-history-label", "Original" } p { "{record.original_text}" } }
                    for entry in record.revisions {
                        li { key: "{entry.revision_id}",
                            span { class: "message-history-label", "{entry_label(entry.kind, entry.source)}" }
                            if let Some(text) = entry.text { p { "{text}" } }
                        }
                    }
                }
            } else if !error().is_empty() {
                p { class: "message-action-error", role: "alert", "{error}" }
            }
        }
    }
}

fn entry_label(kind: MessageRevisionKind, source: MessageRevisionSource) -> &'static str {
    match (kind, source) {
        (MessageRevisionKind::Edit, MessageRevisionSource::Web) => "Edited",
        (MessageRevisionKind::Edit, MessageRevisionSource::Whatsapp) => "Edited in WhatsApp",
        (MessageRevisionKind::Delete, MessageRevisionSource::Web) => "Deleted",
        (MessageRevisionKind::Delete, MessageRevisionSource::Whatsapp) => "Deleted in WhatsApp",
    }
}
