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
    let _ = document::eval(&format!("{source}\nconst id={input};if(!keepsFragment(location.hash,id)){{const fragment=id===null?'':conversationFragment(id);history.replaceState(null,'',location.pathname+location.search+fragment);}}return null;"));
}

/// The view named by the current fragment, if it names one.
pub async fn read_route() -> Option<orkestr_v2_ui::route::Route> {
    let hash = document::eval("return location.hash;")
        .join::<String>()
        .await
        .ok()?;
    orkestr_v2_ui::route::Route::parse(&hash)
}

/// A new history entry for a view the owner opened (back returns to it).
pub fn push(route: &orkestr_v2_ui::route::Route) {
    let hash = serde_json::to_string(&route.hash()).expect("fragment");
    let _ = document::eval(&format!(
        "if(location.hash!=={hash})history.pushState(null,'',location.pathname+location.search+{hash});return null;"
    ));
}

/// Waits for the next back/forward navigation; returns the new fragment.
pub async fn next_navigation() -> Option<String> {
    document::eval("await new Promise(r=>{addEventListener('popstate',r,{once:true});addEventListener('hashchange',r,{once:true});});return location.hash;")
        .join::<String>()
        .await
        .ok()
}
