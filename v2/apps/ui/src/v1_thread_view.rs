use dioxus::prelude::*;
use orkestr_v2_contracts::{
    SidebarAuthor, SidebarEntry, V1HistoryMessage, V1HistoryPage, V1ThreadInputReceipt,
};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    v1_input::{self, Failed},
    Draft,
};
use serde_json::{json, Value};
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
                            "data-phase": message.phase.clone().unwrap_or_default(),
                            article {
                                strong { match message.author { SidebarAuthor::Owner => "You", SidebarAuthor::Participant => "Group member", SidebarAuthor::Assistant if message.coordinator => "Coordinator", SidebarAuthor::Assistant => "Assistant" } }
                                p { "{message.text}" }
                            }
                            if let Some(at) = message.created_at_ms {
                                crate::message_time_view::MessageTime { at_ms: at, now_ms: now(), receipts: message.receipts.clone() }
                            }
                        }
                    }
                }
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
    let owner = session_scope.read().generation();
    let key = v1_input::draft_key(&thread);
    let mut sending = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut mounted = use_signal(|| true);
    let mut attached = use_signal(Vec::<orkestr_v2_ui::composer_attachments::Attached>::new);
    // Upload ids frozen with the pending input, so a retry resends them.
    let mut frozen = use_signal(Vec::<String>::new);
    use_drop(move || mounted.set(false));
    let draft = drafts.read().get(&key).cloned().unwrap_or_default();
    let input_key = key.clone();
    let attach_thread = thread.clone();
    let attach_csrf = csrf.clone();
    rsx! {
        form { class: "message-composer v1-composer", onsubmit: move |event| {
            event.prevent_default();
            if sending() || !session_scope.read().is_current(owner) { return; }
            if drafts.peek().get(&key).is_none_or(|d| d.pending.is_none()) {
                let files = attached.peek().clone();
                if !files.is_empty() {
                    let mut all = drafts.write();
                    let draft = all.entry(key.clone()).or_default();
                    let text = orkestr_v2_ui::composer_attachments::v1_text(&draft.text, &files);
                    if text != draft.text { draft.edit(text); }
                }
                frozen.set(orkestr_v2_ui::composer_attachments::ids(&files));
            }
            sending.set(true);
            status.set("Sending to V1…".into());
            let (thread, key, csrf) = (thread.clone(), key.clone(), csrf.clone());
            spawn(async move {
                let current = || mounted() && session_scope.read().is_current(owner);
                let result = async {
                    let id = crate::transport::key().await?;
                    let mut input = v1_input::prepare(drafts.write().entry(key.clone()).or_default(), id)
                        .map_err(|m| crate::transport::Failure::from(m.to_string()))?;
                    input.attachment_ids = frozen.peek().clone();
                    crate::transport::request::<V1ThreadInputReceipt>(
                        "POST", &format!("/api/v2/v1-threads/{thread}/messages"), json!(input), &csrf, "",
                    ).await
                }.await;
                if !current() { return; }
                match result {
                    Ok(receipt) if receipt.is_valid() && receipt.thread_id == thread => {
                        drafts.write().entry(key).or_default().accepted();
                        attached.set(Vec::new());
                        frozen.set(Vec::new());
                        onsent.call(());
                        status.set(if receipt.duplicate { "Already delivered to V1.".into() } else { "Sent to V1.".into() });
                    }
                    Ok(_) => status.set("V1 receipt could not be verified. Retry sends the same message once.".into()),
                    Err(error) => match v1_input::failed(error.status) {
                        Failed::Expired => { onexpired.call(()); return; }
                        Failed::Refused => {
                            drafts.write().entry(key).or_default().pending = None;
                            frozen.set(Vec::new());
                            status.set(error.message);
                        }
                        Failed::Retry => status.set(format!("{} Retry sends the same message once.", error.message)),
                    },
                }
                sending.set(false);
            });
        },
            label { r#for: "v1-composer", "Message to V1" }
            textarea { id: "v1-composer", rows: 3, value: "{draft.text}", "aria-describedby": "v1-composer-help",
                oninput: move |event| { if session_scope.read().is_current(owner) { drafts.write().entry(input_key.clone()).or_default().edit(event.value()); } }
            }
            crate::composer_tools::AttachTools { target: crate::composer_tools::AttachTarget::V1(attach_thread.clone()), csrf: attach_csrf.clone(), attached, disabled: sending() || draft.pending.is_some() }
            crate::composer_tools::EnterSend { id: "v1-composer" }
            p { id: "v1-composer-help", if draft.pending.is_some() { "Retry sends the original message once. Your newer edits stay in the composer." } else { "Enter sends · Shift+Enter adds a new line. Sent as owner input to this V1 thread; the reply appears here, not in WhatsApp." } }
            button { r#type: "submit", disabled: sending(), if draft.pending.is_some() { "Retry send" } else { "Send" } }
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
