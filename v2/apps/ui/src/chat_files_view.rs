//! "In this chat" in a conversation's Files panel (ORK-809): one card per
//! file the owner attached or the assistant sent, newest first, with who sent
//! it, Preview and Download. The cards are the message file cards: names come
//! from the message notes, and every Preview or Download loads and verifies
//! the file in this conversation's scope.
use dioxus::prelude::*;
use orkestr_v2_ui::{chat_files::ChatFile, session_scope::SessionScope};
use std::hash::{DefaultHasher, Hash, Hasher};

#[component]
pub fn ChatFiles(
    conversation: String,
    files: Vec<ChatFile>,
    session_scope: Signal<SessionScope>,
) -> Element {
    if files.is_empty() {
        return rsx! {
            p { class: "files-empty", "No files yet. Files you attach and files the assistant sends show here, newest first." }
        };
    }
    // The cards are mounted once per list; a new file mounts the list again.
    let mut hasher = DefaultHasher::new();
    for file in &files {
        (&file.file.kind, &file.file.id, &file.file.reference).hash(&mut hasher);
    }
    let list = hasher.finish();
    rsx! { ChatFileCards { key: "{list}", conversation, files, session_scope } }
}

#[component]
fn ChatFileCards(
    conversation: String,
    files: Vec<ChatFile>,
    session_scope: Signal<SessionScope>,
) -> Element {
    let root = format!("chat-files-{conversation}");
    crate::message_files_view::use_file_cards(
        root.clone(),
        conversation,
        serde_json::json!(files),
        session_scope,
    );
    rsx! {
        style { "{include_str!(\"message_files.css\")}" }
        div { id: "{root}", class: "message-files chat-files", "aria-label": "Files in this chat", "Loading files…" }
    }
}
