use dioxus::prelude::*;
use orkestr_v2_contracts::{SidebarAuthor, SidebarEntry, V1HistoryMessage, V1HistoryPage};
use orkestr_v2_ui::{
    chat_timeline::{split_reply_line, QuoteAuthor},
    outbox::{Outbox, Target},
    session_scope::SessionScope,
    v1_input, Draft,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Recent history of a linked V1 chat and an owner composer. The chat runs on
/// V1 (for example a fast layer that may wake an attached coordinator); a
/// message sent here is V1 web UI input whose reply stays in the app. Replies,
/// coordinator posts included, appear live. A chat delegated to V2 is shown
/// without a composer.
#[component]
pub fn V1ThreadView(
    entry: SidebarEntry,
    csrf: String,
    session_scope: Signal<SessionScope>,
    drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let thread = entry.v1_thread_id.clone().unwrap_or_default();
    let now = crate::message_time_view::use_now();
    let mut mounted = use_signal(|| true);
    let mut messages = use_signal(Vec::<V1HistoryMessage>::new);
    let mut before = use_signal(|| None::<i64>);
    let mut notice = use_signal(String::new);
    let mut loading = use_signal(|| false);
    let mut loaded = use_signal(|| false);
    let mut writable = use_signal(|| false);
    let mut working = use_signal(|| false);
    let mut quick = use_signal(|| 0_u32);
    let mut mode = use_signal(|| "chat");
    use_drop(move || mounted.set(false));
    let path = move |thread: &str, before: Option<i64>| match before {
        Some(b) => format!("/api/v2/v1-threads/{thread}/messages?before={b}"),
        None => format!("/api/v2/v1-threads/{thread}/messages"),
    };
    let latest = thread.clone();
    // Newest page now and on every poll; merged by cursor, never duplicated.
    use_future(move || {
        let thread = latest.clone();
        async move {
            loop {
                let result = crate::transport::request::<V1HistoryPage>(
                    "GET",
                    &path(&thread, None),
                    Value::Null,
                    "",
                    "",
                )
                .await;
                if !mounted() || !session_scope.read().is_current(owner) {
                    return;
                }
                match result {
                    Ok(page) if page.is_valid() && page.thread_id == thread => {
                        if !loaded() {
                            before.set(page.before_cursor);
                        }
                        writable.set(page.writable);
                        working.set(page.working);
                        let mut list = messages.write();
                        merge(&mut list, page.messages);
                        loaded.set(true);
                        notice.set(String::new());
                    }
                    Ok(_) => notice.set("V1 history could not be verified.".into()),
                    Err(error) if error.status == 401 => {
                        onexpired.call(());
                        return;
                    }
                    Err(error) => notice.set(format!("V1 history unavailable: {}", error.message)),
                }
                let left = *quick.peek();
                quick.set(left.saturating_sub(1));
                crate::transport::sleep(v1_input::poll_ms(*working.peek(), left)).await;
                if !mounted() {
                    return;
                }
            }
        }
    });
    let older = thread.clone();
    let badge = if entry.coordinator {
        "On V1 · coordinator"
    } else {
        "On V1"
    };
    rsx! {
        nav { class: "v1-tabs", "aria-label": "V1 chat sections",
            for (value, name) in [("chat", "Chat"), ("settings", "Settings"), ("timers", "Timers")] {
                button { r#type: "button", "aria-current": if mode() == value { "page" } else { "false" }, onclick: move |_| mode.set(value), "{name}" }
            }
        }
        if mode() == "chat" {
        section { class: "conversation-pane v1-thread", "aria-label": "Linked V1 chat",
            div { class: "conversation-scroll", tabindex: "0", "aria-label": "V1 chat history",
                div { class: "v1-banner", role: "note",
                    span { class: "source-badge", "{badge}" }
                    if !loaded() || writable() {
                        p { "This chat runs on V1. Messages you send here reach it as owner input, exactly like V1's web UI. It becomes a full conversation when it moves to V2." }
                    } else {
                        p { "This chat runs on V2. Write in its V2 conversation; nothing is sent from here." }
                    }
                }
                if let Some(cursor) = before() {
                    button { class: "load-older", disabled: loading(), onclick: move |_| {
                        let thread = older.clone();
                        loading.set(true);
                        spawn(async move {
                            let result = crate::transport::request::<V1HistoryPage>("GET", &path(&thread, Some(cursor)), Value::Null, "", "").await;
                            if !mounted() { return; }
                            loading.set(false);
                            match result {
                                Ok(page) if page.is_valid() && page.thread_id == thread => {
                                    before.set(page.before_cursor);
                                    merge(&mut messages.write(), page.messages);
                                }
                                Ok(_) => notice.set("V1 history could not be verified.".into()),
                                Err(error) => notice.set(format!("Older V1 messages unavailable: {}", error.message)),
                            }
                        });
                    }, if loading() { "Loading…" } else { "Load older messages" } }
                }
                ol { class: "chat-messages",
                    for message in messages.read().iter() {
                        li { key: "{message.cursor}", class: match message.author { SidebarAuthor::Owner => "user-message", _ => "assistant-message" },
                            "data-phase": message.phase.clone().unwrap_or_default(), "data-replyable": "true",
                            article {
                                strong { match message.author { SidebarAuthor::Owner => "You", SidebarAuthor::Participant => "Group member", SidebarAuthor::Assistant if message.coordinator => "Coordinator", SidebarAuthor::Assistant => "Assistant" } }
                                if let Some((label, snippet, rest)) = split_reply_line(&message.text) {
                                    crate::outbox_view::Quote { label, text: snippet }
                                    crate::rich_text_view::RichText { text: rest }
                                } else {
                                    crate::rich_text_view::RichText { text: message.text.clone() }
                                }
                                if writable() {
                                    crate::outbox_view::ReplyButton { draft_key: v1_input::draft_key(&thread), composer: "v1-composer", message_id: message.message_id.clone(),
                                        author: match message.author { SidebarAuthor::Owner => QuoteAuthor::Owner, SidebarAuthor::Assistant => QuoteAuthor::Assistant, SidebarAuthor::Participant => QuoteAuthor::Other },
                                        text: split_reply_line(&message.text).map(|(_, _, rest)| rest).unwrap_or_else(|| message.text.clone()) }
                                }
                            }
                            if let Some(at) = message.created_at_ms {
                                crate::message_time_view::MessageTime { at_ms: at, now_ms: now(), receipts: message.receipts.clone() }
                            }
                        }
                    }
                }
                crate::outbox_view::OutboxBubbles { target: Target::V1(thread.clone()), shown: messages.read().iter().map(|m| m.message_id.clone()).collect::<Vec<_>>() }
                if loaded() && working() { p { class: "v1-typing", role: "status", "typing…" } }
                if loaded() && messages.read().is_empty() { p { class: "empty-conversation", "No messages yet." } }
                if !loaded() && notice().is_empty() { p { class: "empty-conversation", "Loading V1 history…" } }
                p { role: "status", class: "v1-notice", "{notice}" }
            }
            crate::scroll_pin::ScrollPin {}
            if loaded() && writable() {
                div { class: "composer-dock",
                    V1Composer { thread: thread.clone(), csrf: csrf.clone(), session_scope, drafts, onexpired, onsent: move |_| quick.set(v1_input::QUICK_POLLS_AFTER_SEND) }
                }
            }
        }
        } else {
            div { class: "conversation-scroll v1-manage",
                if mode() == "settings" {
                    crate::v1_manage_view::V1Settings { thread: thread.clone(), csrf: csrf.clone(), session_scope, onexpired }
                } else {
                    crate::v1_manage_view::V1Timers { thread: thread.clone(), csrf: csrf.clone(), session_scope, onexpired }
                }
            }
        }
    }
}

#[component]
fn V1Composer(
    thread: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
    onsent: EventHandler<()>,
) -> Element {
    let _ = onexpired;
    let owner = session_scope.read().generation();
    let key = v1_input::draft_key(&thread);
    let outbox = use_context::<Signal<Outbox>>();
    let status = use_signal(String::new);
    let attached = use_signal(Vec::<orkestr_v2_ui::composer_attachments::Attached>::new);
    let text = drafts
        .read()
        .get(&key)
        .map(|d| d.text.clone())
        .unwrap_or_default();
    let input_key = key.clone();
    let preview_key = key.clone();
    let attach_thread = thread.clone();
    rsx! {
        crate::outbox_view::ReplyPreview { draft_key: preview_key }
        form { class: "message-composer v1-composer", onsubmit: move |event| {
            event.prevent_default();
            if !session_scope.read().is_current(owner) { return; }
            if crate::outbox_view::submit(Target::V1(thread.clone()), drafts, attached, outbox, status) {
                onsent.call(());
            }
        },
            label { r#for: "v1-composer", "Message to V1" }
            textarea { id: "v1-composer", rows: 3, value: "{text}", "aria-describedby": "v1-composer-help",
                oninput: move |event| { if session_scope.read().is_current(owner) { drafts.write().entry(input_key.clone()).or_default().edit(event.value()); } }
            }
            crate::composer_tools::AttachTools { target: crate::composer_tools::AttachTarget::V1(attach_thread.clone()), csrf: csrf.clone(), attached, disabled: false }
            crate::composer_tools::EnterSend { id: "v1-composer" }
            p { id: "v1-composer-help", "Enter sends · Shift+Enter adds a new line. Sent as owner input to this V1 thread; the reply appears here, not in WhatsApp." }
            button { r#type: "submit", "Send" }
            if !status().is_empty() { p { class: "composer-notice", role: "status", "{status}" } }
        }
    }
}

fn merge(list: &mut Vec<V1HistoryMessage>, page: Vec<V1HistoryMessage>) {
    for message in page {
        match list.binary_search_by_key(&message.cursor, |m| m.cursor) {
            Ok(index) => list[index] = message,
            Err(index) => list.insert(index, message),
        }
    }
}
