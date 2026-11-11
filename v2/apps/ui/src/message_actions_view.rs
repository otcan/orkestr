//! Edit or delete the owner's own message. The server decides whether it may;
//! these controls are only offered on rows it marked as revisable. They are
//! started from the message's actions menu (`MessageMenu`, below), which
//! owns the mode; `MessageActions` shows the edit form or the delete
//! confirmation.
use crate::transport;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    MessageRevisionHistory, MessageRevisionKind, MessageRevisionReceipt, MessageRevisionSource,
    ReplyTo,
};
use orkestr_v2_ui::{chat_timeline, Draft};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
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
    mut mode: Signal<Mode>,
) -> Element {
    let initial = text.clone();
    let mut draft = use_signal(move || initial);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    // Each time the menu starts an edit, it starts from the message text.
    let mut shown = use_signal(|| Mode::Idle);
    let start_text = text.clone();
    use_effect(move || {
        let now = mode();
        if now != *shown.peek() {
            if now == Mode::Editing {
                draft.set(start_text.clone());
            }
            error.set(String::new());
            shown.set(now);
        }
    });
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
            Mode::Idle => rsx! {},
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

/// The audit record of a changed message, read when the menu opens it.
#[component]
pub fn RevisionHistory(
    conversation: String,
    message_id: String,
    csrf: String,
    onexpired: EventHandler<()>,
) -> Element {
    let mut history = use_signal(|| None::<MessageRevisionHistory>);
    let mut error = use_signal(String::new);
    let path = revisions_path(&conversation, &message_id);
    use_future(move || {
        let (path, csrf) = (path.clone(), csrf.clone());
        async move {
            match transport::request::<MessageRevisionHistory>("GET", &path, Value::Null, &csrf, "")
                .await
            {
                Ok(value) => history.set(Some(value)),
                Err(failure) if failure.status == 401 => onexpired.call(()),
                Err(failure) => error.set(failure.message),
            }
        }
    });
    rsx! {
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
        } else {
            p { class: "message-history-loading", role: "status", "Loading history…" }
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

// One actions menu per message (ORK-786): Reply, Copy text, and for the
// owner's own revisable messages Edit and Delete, plus History of a changed
// message. It replaces the repeated inline controls. The "⋯" button is always
// shown (never hover-only), states whether the menu is open, and the menu
// closes on Escape (focus returns to the button) or on a click elsewhere.
// A long press on touch screens still starts a reply (`reply_gestures.mjs`).
/// What a reply quotes.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplyTarget {
    pub draft_key: String,
    pub composer: String,
    pub author: chat_timeline::QuoteAuthor,
    pub text: String,
}

/// An owner message the server marked revisable.
#[derive(Clone, Debug, PartialEq)]
pub struct Revise {
    pub conversation: String,
    pub text: String,
    pub revision: i64,
    pub csrf: String,
}

/// A changed message whose audit record can be read.
#[derive(Clone, Debug, PartialEq)]
pub struct History {
    pub conversation: String,
    pub csrf: String,
}

/// Focus the element `selector` finds inside the element with `id`, once shown.
fn focus(id: &str, selector: &str) {
    let (id, selector) = (json!(id), json!(selector));
    let _ = document::eval(&format!("for(let i=0;i<40;i++){{const el=document.getElementById({id});const target=el&&({selector}?el.querySelector({selector}):el);if(target&&target.offsetParent!==null){{target.focus();break;}}await new Promise(r=>requestAnimationFrame(r));}}return null;"));
}

#[component]
pub fn MessageMenu(
    message_id: String,
    #[props(default)] reply: Option<ReplyTarget>,
    /// Text "Copy text" puts on the clipboard.
    #[props(default)]
    copy: Option<String>,
    #[props(default)] revise: Option<Revise>,
    #[props(default)] history: Option<History>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut drafts = use_context::<Signal<BTreeMap<String, Draft>>>();
    let mut open = use_signal(|| false);
    let mut mode = use_signal(|| Mode::Idle);
    let mut history_open = use_signal(|| false);
    let mut notice = use_signal(String::new);
    let wrap = format!("message-menu-{message_id}");
    let list = format!("{wrap}-list");
    let toggle = format!("{wrap}-toggle");
    // While open, a click or focus outside the menu closes it.
    let watched = wrap.clone();
    use_effect(move || {
        if !open() {
            return;
        }
        let wrap = json!(watched);
        spawn(async move {
            let outside = document::eval(&format!("return await new Promise(resolve=>{{const done=event=>{{const w=document.getElementById({wrap});if(w&&w.contains(event.target))return;document.removeEventListener('pointerdown',done,true);document.removeEventListener('focusin',done,true);resolve(true);}};document.addEventListener('pointerdown',done,true);document.addEventListener('focusin',done,true);}});"));
            if outside.await.is_ok() {
                open.set(false);
            }
        });
    });
    let close = {
        let toggle = toggle.clone();
        move |refocus: bool| {
            open.set(false);
            if refocus {
                focus(&toggle, "");
            }
        }
    };
    let mut on_key = close.clone();
    let mut after_reply = close.clone();
    let mut after_copy = close.clone();
    let mut after_edit = close.clone();
    let mut after_delete = close.clone();
    let mut after_history = close.clone();
    let opened = list.clone();
    let reply_hidden = reply.clone();
    let quote_id = message_id.clone();
    let start_reply = move |target: &ReplyTarget| {
        let quote: ReplyTo = chat_timeline::quote(&quote_id, target.author, &target.text);
        drafts
            .write()
            .entry(target.draft_key.clone())
            .or_default()
            .quote = Some(quote);
        let _ = document::eval(&format!(
            "document.getElementById({})?.focus(); return null;",
            json!(target.composer)
        ));
    };
    let mut gesture_reply = start_reply.clone();
    let mut menu_reply = start_reply.clone();
    let has_items = reply.is_some() || copy.is_some() || revise.is_some() || history.is_some();
    if !has_items {
        return rsx! {};
    }
    rsx! {
        div { class: "message-menu", id: "{wrap}",
            button { r#type: "button", id: "{toggle}", class: "message-menu-toggle", "aria-label": "Message actions", title: "Message actions",
                "aria-haspopup": "true", "aria-expanded": "{open}", "aria-controls": "{list}",
                onclick: move |_| {
                    let next = !open();
                    open.set(next);
                    notice.set(String::new());
                    if next { focus(&opened, ".message-menu-item"); }
                },
                span { "aria-hidden": "true", "⋯" }
            }
            if open() {
                div { id: "{list}", class: "message-menu-list", role: "group", "aria-label": "Message actions",
                    onkeydown: move |event: KeyboardEvent| { if event.key() == Key::Escape { event.stop_propagation(); on_key(true); } },
                    if let Some(target) = reply.clone() {
                        button { r#type: "button", class: "message-menu-item", onclick: move |_| { after_reply(false); menu_reply(&target); }, "Reply" }
                    }
                    if let Some(text) = copy.clone() {
                        button { r#type: "button", class: "message-menu-item",
                            onclick: move |_| {
                                let text = text.clone();
                                after_copy(true);
                                spawn(async move {
                                    let copied = document::eval("const text=await dioxus.recv();try{await navigator.clipboard.writeText(text);return true;}catch{return false;}");
                                    let _ = copied.send(json!(text));
                                    let done = copied.join::<bool>().await.unwrap_or(false);
                                    notice.set(if done { "Copied." } else { "Copy unavailable in this browser. Select the text to copy it." }.into());
                                });
                            },
                            "Copy text"
                        }
                    }
                    if revise.is_some() {
                        button { r#type: "button", class: "message-menu-item", onclick: move |_| { after_edit(false); mode.set(Mode::Editing); }, "Edit" }
                        button { r#type: "button", class: "message-menu-item message-menu-danger", onclick: move |_| { after_delete(false); mode.set(Mode::ConfirmDelete); }, "Delete" }
                    }
                    if history.is_some() {
                        button { r#type: "button", class: "message-menu-item", "aria-expanded": "{history_open}",
                            onclick: move |_| { after_history(true); let next = !history_open(); history_open.set(next); },
                            if history_open() { "Hide history" } else { "History" }
                        }
                    }
                }
            }
            if let Some(target) = reply_hidden {
                // The long-press gesture on touch screens presses this.
                button { r#type: "button", class: "reply-action", hidden: true, tabindex: "-1", "aria-hidden": "true", onclick: move |_| gesture_reply(&target), "Reply" }
            }
        }
        if !notice().is_empty() { p { class: "message-menu-notice", role: "status", "{notice}" } }
        if let Some(revise) = revise.clone() {
            MessageActions { conversation: revise.conversation, message_id: message_id.clone(), text: revise.text, revision: revise.revision, csrf: revise.csrf, onexpired, mode }
        }
        if let Some(history) = history.clone().filter(|_| history_open()) {
            RevisionHistory { conversation: history.conversation, message_id: message_id.clone(), csrf: history.csrf, onexpired }
        }
    }
}
