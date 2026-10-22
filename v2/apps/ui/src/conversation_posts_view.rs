//! Conversation posts in the chat: assistant-side bubbles with a small label
//! badge (for example "Coordinator"), written from outside any run.
use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationPost, ConversationPosts};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::Value;

/// Same cadence as the conversation's execution poll.
const POLL_MS: u32 = 3000;
const PAGE: u16 = 50;

/// The newest posts of a conversation, oldest first, refreshed every 3 s.
/// A server without the route or a failed read keeps the last good list.
pub fn use_conversation_posts(
    id: String,
    session_scope: Signal<SessionScope>,
) -> Signal<Vec<ConversationPost>> {
    let generation = session_scope.read().generation();
    let mut posts = use_signal(Vec::new);
    use_future(move || {
        let id = id.clone();
        async move {
            let path = format!("/api/v2/conversations/{id}/posts?limit={PAGE}");
            loop {
                if !session_scope.read().is_current(generation) {
                    return;
                }
                if let Ok(page) = crate::transport::request::<ConversationPosts>(
                    "GET",
                    &path,
                    Value::Null,
                    "",
                    "",
                )
                .await
                {
                    if page.is_valid()
                        && page.conversation_id.to_string() == id
                        && *posts.peek() != page.posts
                    {
                        posts.set(page.posts);
                    }
                }
                crate::transport::sleep(POLL_MS).await;
            }
        }
    });
    posts
}

#[component]
pub fn PostBubble(post: ConversationPost) -> Element {
    rsx! { article { "data-post-id": "{post.id}", "data-post-author": "{post.author.as_str()}",
        strong { "Assistant" }
        span { class: "post-badge", "{post.label}" }
        p { "{post.text}" }
    } }
}
