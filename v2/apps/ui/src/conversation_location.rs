use dioxus::prelude::*;

pub async fn read() -> Option<String> {
    let source = include_str!("selected_conversation.mjs").replace("export function", "function");
    document::eval(&format!(
        "{source}\nreturn selectedConversation(location.hash);"
    ))
    .join::<Option<String>>()
    .await
    .ok()
    .flatten()
}

/// `(instance, thread)` public references of an old V1 deep link.
pub async fn read_v1_link() -> Option<(String, String)> {
    let source = include_str!("selected_conversation.mjs").replace("export function", "function");
    document::eval(&format!("{source}\nreturn selectedV1Link(location.hash);"))
        .join::<Option<(String, String)>>()
        .await
        .ok()
        .flatten()
}

pub fn replace(id: Option<&str>) {
    let source = include_str!("selected_conversation.mjs").replace("export function", "function");
    let input = serde_json::to_string(&id).expect("optional string");
    let _ = document::eval(&format!("{source}\nconst id={input};const fragment=id===null?'':conversationFragment(id);history.replaceState(null,'',location.pathname+location.search+fragment);return null;"));
}
