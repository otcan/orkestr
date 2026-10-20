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

pub fn replace(id: Option<&str>) {
    let source = include_str!("selected_conversation.mjs").replace("export function", "function");
    let input = serde_json::to_string(&id).expect("optional string");
    let _ = document::eval(&format!("{source}\nconst id={input};const fragment=id===null?'':conversationFragment(id);history.replaceState(null,'',location.pathname+location.search+fragment);return null;"));
}
