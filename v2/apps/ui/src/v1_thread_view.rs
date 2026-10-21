use dioxus::prelude::*;
use orkestr_v2_contracts::{SidebarAuthor, SidebarEntry, V1HistoryMessage, V1HistoryPage};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::Value;

const POLL_MS: u32 = 8000;

/// Read-only recent history of a linked V1 chat. It runs on V1 (for example
/// with a coordinator session attached); nothing here sends to it.
#[component]
pub fn V1ThreadView(
    entry: SidebarEntry,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let thread = entry.v1_thread_id.clone().unwrap_or_default();
    let mut mounted = use_signal(|| true);
    let mut messages = use_signal(Vec::<V1HistoryMessage>::new);
    let mut before = use_signal(|| None::<i64>);
    let mut notice = use_signal(String::new);
    let mut loading = use_signal(|| false);
    let mut loaded = use_signal(|| false);
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
                crate::transport::sleep(POLL_MS).await;
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
        section { class: "conversation-pane v1-thread", "aria-label": "Linked V1 chat",
            div { class: "conversation-scroll", tabindex: "0", "aria-label": "V1 chat history",
                div { class: "v1-banner", role: "note",
                    span { class: "source-badge", "{badge}" }
                    p { "This chat still runs on V1. History is read-only here; reply in its WhatsApp group. It becomes a full conversation when it moves to V2." }
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
                                strong { match message.author { SidebarAuthor::Owner => "You", SidebarAuthor::Participant => "Group member", SidebarAuthor::Assistant => "Assistant" } }
                                p { "{message.text}" }
                            }
                        }
                    }
                }
                if loaded() && messages.read().is_empty() { p { class: "empty-conversation", "No messages yet." } }
                if !loaded() && notice().is_empty() { p { class: "empty-conversation", "Loading V1 history…" } }
                p { role: "status", class: "v1-notice", "{notice}" }
            }
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
