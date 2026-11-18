//! Reads a conversation's run updates for the chat: the newest pages when the
//! chat opens, then forward from the newest known update whenever the live
//! stream advances (`update` is the chat's accepted-replies revision). No
//! polling of its own. A server without the route keeps the list empty, and
//! the chat then shows replies only, as before.
use dioxus::prelude::*;
use orkestr_v2_contracts::{RunUpdate, RunUpdates};
use orkestr_v2_ui::{
    accepted_payloads::Answer,
    live_answer::MessageKind,
    run_updates::{
        after_path, merge, newest_path, older_cursor, valid_forward, valid_newest,
        LIVE_UPDATE_PAGES, NEWEST_UPDATE_PAGES,
    },
    session_scope::SessionScope,
};
use serde_json::Value;
use std::collections::BTreeMap;

async fn page(path: &str) -> Result<RunUpdates, u16> {
    crate::transport::request::<RunUpdates>("GET", path, Value::Null, "", "")
        .await
        .map_err(|error| error.status)
}

pub fn use_run_updates(
    id: String,
    update: Signal<i64>,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Signal<BTreeMap<i64, RunUpdate>> {
    let generation = session_scope.read().generation();
    let mut rows = use_signal(BTreeMap::<i64, RunUpdate>::new);
    let mut opened = use_signal(|| false);
    use_resource(move || {
        let _ = update();
        let id = id.clone();
        async move {
            let current = || session_scope.read().is_current(generation);
            if !*opened.peek() {
                // Opening: the newest pages, which cover the replies on screen.
                let mut before = i64::MAX;
                for _ in 0..NEWEST_UPDATE_PAGES {
                    let result = page(&newest_path(&id, before)).await;
                    if !current() {
                        return;
                    }
                    match result {
                        Ok(read) if valid_newest(&read, &id, before) => {
                            if merge(&mut rows.write(), &read.updates).is_err() {
                                return;
                            }
                            match older_cursor(&read) {
                                Some(cursor) => before = cursor,
                                None => break,
                            }
                        }
                        Err(401) => {
                            onexpired.call(());
                            return;
                        }
                        _ => return,
                    }
                }
                opened.set(true);
                return;
            }
            // Live: everything after the newest update already read.
            let mut after = rows.peek().keys().next_back().copied().unwrap_or(0);
            for _ in 0..LIVE_UPDATE_PAGES {
                let result = page(&after_path(&id, after)).await;
                if !current() {
                    return;
                }
                match result {
                    Ok(read) if valid_forward(&read, &id, after) => {
                        if !read.updates.is_empty()
                            && merge(&mut rows.write(), &read.updates).is_err()
                        {
                            return;
                        }
                        match read.next_after_sequence {
                            Some(next) => after = next,
                            None => break,
                        }
                    }
                    Err(401) => {
                        onexpired.call(());
                        return;
                    }
                    _ => return,
                }
            }
        }
    });
    rows
}

/// One interim update: its own message, muted and marked Update, with Copy
/// and Reply like any answer. A suppression marker shows nothing.
#[component]
pub fn UpdateBubble(
    conversation: String,
    update: RunUpdate,
    /// The text read for it (ORK-797 reader, shared with accepted answers).
    answer: Answer,
    onexpired: EventHandler<()>,
) -> Element {
    let text = match &answer {
        Answer::Read(Some(text)) if !orkestr_v2_ui::payload::silent_assistant_reply(text) => {
            Some(text.clone())
        }
        _ => None,
    };
    let notice = match &answer {
        Answer::Read(None) => "Update text removed.",
        Answer::Failed => "This update could not be loaded.",
        _ => "",
    };
    rsx! { article { "data-run-id": "{update.run_id}", "data-payload-id": "{update.payload_id}", "data-message-kind": "update",
        strong { "Assistant" }
        crate::accepted_results_view::KindLabel { kind: MessageKind::Update }
        span { class: "reply-state", "{notice}" }
        if let Some(text) = text.clone() {
            div { class: "update-output", crate::rich_text_view::RichText { text: orkestr_v2_ui::message_file_refs::display_text(&text) } }
        }
        if let Some(text) = text {
            crate::message_actions_view::MessageMenu { message_id: update.payload_id.to_string(),
                copy: Some(orkestr_v2_ui::message_file_refs::display_text(&text)),
                reply: Some(crate::message_actions_view::ReplyTarget { draft_key: conversation.clone(), composer: "composer".into(),
                    author: orkestr_v2_ui::chat_timeline::QuoteAuthor::Assistant, text }),
                onexpired }
        }
    } }
}
