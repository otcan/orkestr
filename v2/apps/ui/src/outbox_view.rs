//! Send gestures and delivery states of outbox items. Sending never blocks
//! the composer: the text leaves it at once and the item shows its own state.
use crate::outbox_driver::{kick, now_ms};
use dioxus::prelude::*;
use orkestr_v2_contracts::ReplyTo;
use orkestr_v2_ui::{
    chat_timeline::{self, QuoteAuthor},
    composer_attachments::{self, Attached},
    outbox::{Item, Outbox, Phase, Target},
    Draft,
};
use std::{cell::Cell, collections::BTreeMap};

thread_local! {
    static LOCAL: Cell<u64> = const { Cell::new(0) };
}

/// Freeze the composer's text (and files) into a new outbox item, in order,
/// and clear the composer at once. The item gets its idempotency key a moment
/// later; it holds its place meanwhile. Returns false when nothing was sent.
pub fn submit(
    target: Target,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    mut attached: Signal<Vec<Attached>>,
    mut outbox: Signal<Outbox>,
    mut status: Signal<String>,
) -> bool {
    let draft_key = target.draft_key();
    let quote = drafts.peek().get(&draft_key).and_then(|d| d.quote.clone());
    let (typed, legacy) = drafts
        .peek()
        .get(&draft_key)
        .map(|d| {
            // A send left unconfirmed by an older page keeps its key, so the
            // server admits it once.
            let legacy = d
                .pending
                .as_ref()
                .filter(|p| p.input.text == d.text)
                .map(|p| p.input.client_message_id.clone());
            (d.text.clone(), legacy)
        })
        .unwrap_or_default();
    let files = attached.peek().clone();
    let (text, attachment_ids) = match target {
        Target::Native(_) => (
            composer_attachments::native_text(&typed, &files),
            Vec::new(),
        ),
        Target::V1(_) => (
            composer_attachments::v1_text(&typed, &files),
            composer_attachments::ids(&files),
        ),
    };
    if text.trim().is_empty() {
        return false;
    }
    // A reply carries the visible `[Replying to …]` line the model reads
    // (as a WhatsApp reply does) and, for V2, the structured quote.
    let text = match &quote {
        Some(quote) => chat_timeline::with_reply_line(&text, quote),
        None => text,
    };
    let legacy = legacy.filter(|_| quote.is_none());
    let local = format!(
        "local-{}",
        LOCAL.with(|n| {
            n.set(n.get() + 1);
            n.get()
        })
    );
    let key_target = target.clone();
    let item = match Item::new(local.clone(), target, text, quote, attachment_ids) {
        Ok(item) => item,
        Err(message) => {
            status.set(message.into());
            return false;
        }
    };
    if !outbox.write().enqueue(item) {
        status
            .set("Too many unsent messages. Wait for them to send, or discard failed ones.".into());
        return false;
    }
    {
        let mut all = drafts.write();
        let draft = all.entry(draft_key.clone()).or_default();
        draft.edit(String::new());
        draft.pending = None;
        draft.quote = None;
    }
    attached.set(Vec::new());
    status.set(String::new());
    spawn(async move {
        let key = match legacy.filter(|_| files.is_empty()) {
            Some(key) => Ok(key),
            None => crate::transport::key()
                .await
                .map(|uuid| key_target.message_key(&uuid)),
        };
        let now = now_ms().await;
        let activated = key.is_ok_and(|key| outbox.write().activate(&local, key, now));
        if activated {
            kick();
            return;
        }
        // Without a key nothing was sent: give the text back if the composer is empty.
        if let Some(item) = outbox.write().abandon(&local) {
            let mut all = drafts.write();
            let draft = all.entry(draft_key).or_default();
            if draft.text.trim().is_empty() {
                draft.edit(item.display_text());
                draft.quote = item.reply_to.clone();
            }
        }
        status.set("Secure request ID unavailable; the message is back in the composer.".into());
    });
    true
}

fn retry(mut outbox: Signal<Outbox>, key: String) {
    spawn(async move {
        let target = outbox.peek().get(&key).map(|item| item.target.clone());
        let fresh = crate::transport::key()
            .await
            .ok()
            .zip(target)
            .map(|(uuid, target)| target.message_key(&uuid));
        let now = now_ms().await;
        outbox.write().retry(&key, fresh, now);
        kick();
    });
}

/// State line under a message: Sending / Sent / Failed with Retry.
#[component]
pub fn DeliveryState(item: Item) -> Element {
    let mut outbox = use_context::<Signal<Outbox>>();
    let key = item.key.clone();
    let discard_key = item.key.clone();
    let state = match item.phase {
        Phase::Sending => "sending",
        Phase::Sent => "sent",
        Phase::Failed => "failed",
    };
    rsx! {
        div { class: "delivery", "data-delivery": state, role: "status",
            span { class: "delivery-state", "{item.state_label()}" }
            if !item.notice.is_empty() { span { class: "delivery-notice", "{item.notice}" } }
            if item.phase == Phase::Failed && item.ready {
                button { r#type: "button", class: "delivery-retry", onclick: move |_| retry(outbox, key.clone()), "Retry" }
            }
            if item.phase == Phase::Failed && !item.retrying {
                button { r#type: "button", class: "delivery-discard", onclick: move |_| { outbox.write().discard(&discard_key); }, "Discard" }
            }
        }
    }
}

/// Outbox items of `target` the timeline does not show yet (`shown` holds
/// the server message ids on screen), newest last.
#[component]
pub fn OutboxBubbles(target: Target, shown: Vec<String>) -> Element {
    let outbox = use_context::<Signal<Outbox>>();
    let items: Vec<Item> = outbox
        .read()
        .for_target(&target)
        .filter(|i| i.message_id.as_ref().is_none_or(|id| !shown.contains(id)))
        .cloned()
        .collect();
    if items.is_empty() {
        return rsx! {};
    }
    rsx! {
        ol { class: "chat-messages outbox-messages", "aria-label": "Messages being sent",
            for item in items {
                li { key: "{item.view_key()}", class: "user-message outbox-message", "data-outbox-key": "{item.key}",
                    article {
                        strong { "You" }
                        if let Some(quote) = &item.reply_to { Quote { label: chat_timeline::quote_label(quote).to_string(), text: quote.text.clone() } }
                        crate::rich_text_view::RichText { text: item.display_text() }
                    }
                    DeliveryState { item: item.clone() }
                }
            }
        }
    }
}

/// The delivery state of a timeline message this page sent, while unfinished.
#[component]
pub fn TimelineDelivery(message_id: String) -> Element {
    let outbox = use_context::<Signal<Outbox>>();
    let item = outbox
        .read()
        .by_message(&message_id)
        .filter(|i| i.phase != Phase::Sent)
        .cloned();
    match item {
        Some(item) => rsx! { DeliveryState { item } },
        None => rsx! {},
    }
}

/// A quoted message above a reply.
#[component]
pub fn Quote(label: String, text: String) -> Element {
    rsx! {
        blockquote { class: "reply-quote", "data-reply-quote": "true",
            cite { "{label}" }
            if !text.is_empty() { p { "{text}" } }
        }
    }
}

/// Reply to a message: quote it in the composer of `draft_key` and focus it.
/// Shown on hover; a long press on touch screens presses it (see `reply_gestures.mjs`).
#[component]
pub fn ReplyButton(
    draft_key: String,
    composer: String,
    message_id: String,
    author: QuoteAuthor,
    text: String,
) -> Element {
    let mut drafts = use_context::<Signal<BTreeMap<String, Draft>>>();
    rsx! {
        button { r#type: "button", class: "reply-action", title: "Reply", "aria-label": "Reply to this message",
            onclick: move |_| {
                let quote = chat_timeline::quote(&message_id, author, &text);
                drafts.write().entry(draft_key.clone()).or_default().quote = Some(quote);
                let _ = document::eval(&format!("document.getElementById({})?.focus(); return null;", serde_json::json!(composer)));
            },
            "\u{21a9}\u{fe0e} Reply"
        }
    }
}

/// The quoted message above the composer, with a way to cancel the reply.
#[component]
pub fn ReplyPreview(draft_key: String) -> Element {
    let mut drafts = use_context::<Signal<BTreeMap<String, Draft>>>();
    let quote: Option<ReplyTo> = drafts.read().get(&draft_key).and_then(|d| d.quote.clone());
    let Some(quote) = quote else { return rsx! {} };
    rsx! {
        div { class: "composer-quote", role: "group", "aria-label": "Replying to",
            Quote { label: chat_timeline::quote_label(&quote).to_string(), text: quote.text.clone() }
            button { r#type: "button", class: "composer-quote-cancel", "aria-label": "Cancel reply",
                onclick: move |_| { if let Some(draft) = drafts.write().get_mut(&draft_key) { draft.quote = None; } }, "×" }
        }
    }
}

/// Long press on a message (touch screens) starts a reply. Installed once.
#[component]
pub fn ReplyGestures() -> Element {
    use_effect(|| {
        let source = include_str!("reply_gestures.mjs").replace("export ", "");
        let _ = document::eval(&format!(
            "{source}\ninstallReplyGestures(document); return null;"
        ));
    });
    rsx! {}
}
