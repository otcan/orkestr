use dioxus::prelude::*;
use orkestr_v2_contracts::ArchivedHistoryPage;
use orkestr_v2_ui::{
    archived_history::{preview, role_label, ArchivedTimeline},
    session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::json;
use std::{cell::Cell, rc::Rc};

#[derive(Deserialize)]
struct Reply {
    status: u16,
    text: String,
}

fn start(conversation: &str, after: i64, limit: u32) -> document::Eval {
    let source = include_str!("archived_history_request.mjs")
        .replace("export async function", "async function");
    let script = format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await archivedHistoryRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(json!({"conversation":conversation,"after":after.to_string(),"limit":limit}));
    eval
}

/// Imported legacy messages, oldest first, shown before native conversation input.
/// They are read-only provenance and are never sent, replayed or executed.
#[component]
pub fn ArchivedHistory(
    id: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let timeline_id = id.clone();
    let mut timeline = use_signal(move || ArchivedTimeline::new(&timeline_id));
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut more = use_signal(|| 0_u64);
    let mut limit = use_signal(|| 50_u32);
    let mut busy = use_signal(|| false);
    let mut notice = use_signal(String::new);
    let ticket = use_hook(|| Rc::new(Cell::new(0_u64)));
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_resource(move || {
        let _ = more();
        let page_limit = limit();
        let id = id.clone();
        let current = ticket.get() + 1;
        ticket.set(current);
        let ticket = ticket.clone();
        async move {
            let Some(after) = timeline.peek().cursor() else {
                return;
            };
            if let Some(old) = channel.peek().as_ref() {
                let _ = old.send(json!({"stop":true}));
            }
            busy.set(true);
            let eval = start(&id, after, page_limit);
            channel.set(Some(eval));
            let reply = eval.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(owner) || ticket.get() != current {
                return;
            }
            channel.set(None);
            busy.set(false);
            match reply {
                Ok(reply) if reply.status == 200 => {
                    let applied = serde_json::from_str::<ArchivedHistoryPage>(&reply.text)
                        .map_err(|_| "Archived history could not be verified.")
                        .and_then(|page| timeline.write().apply(after, page));
                    notice.set(applied.err().unwrap_or_default().into());
                }
                Ok(reply) if reply.status == 413 && page_limit > 1 => {
                    limit.set((page_limit / 5).max(1));
                }
                Ok(reply) if reply.status == 401 || reply.status == 403 => onexpired.call(()),
                Ok(reply) if reply.status == 404 => notice.set(String::new()),
                _ => notice
                    .set("Imported history unavailable. Native messages are unaffected.".into()),
            }
        }
    });
    let view = timeline.read();
    if view.loaded() && view.is_empty() && notice().is_empty() {
        return rsx! {};
    }
    let count = view.len();
    let has_more = view.cursor().is_some() && view.loaded();
    rsx! {
        details { class: "archived-history", open: true, "aria-label": "Imported history",
            summary {
                strong { "Imported V1 history" }
                span { if has_more { " · {count} loaded, more available" } else { " · {count} messages" } }
            }
            p { class: "archived-note", "Read-only archive. These messages are never sent, replayed or run again." }
            if view.trimmed() { p { class: "archived-note", "Earliest imported messages were unloaded to keep this page fast. Reload to read from the beginning." } }
            ol { class: "archived-messages", "aria-live": "off",
                for entry in view.entries() {
                    li { key: "{entry.archive_sequence}",
                        class: if entry.message.role == "user" { "archived-message archived-user" } else { "archived-message" },
                        article {
                            header {
                                strong { "{role_label(&entry.message.role)}" }
                                if let Some(at) = entry.message.created_at.as_ref() { time { "{at}" } }
                                span { class: "archived-badge", "Archived" }
                            }
                            {
                                let (head, cut) = preview(&entry.message.text);
                                rsx! {
                                    p { "{head}" }
                                    if cut { details { summary { "Show full message" } p { "{entry.message.text}" } } }
                                }
                            }
                            if !entry.message.attachments.is_empty() {
                                ul { class: "archived-attachments",
                                    for (index, file) in entry.message.attachments.iter().enumerate() {
                                        li { key: "{index}", if file.available { "{file.name}" } else { "{file.name} (not imported)" } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if !notice().is_empty() { p { role: "status", "{notice}" } }
            if has_more || !view.loaded() {
                button { r#type: "button", disabled: busy(), onclick: move |_| more += 1,
                    if busy() { "Loading imported history…" } else { "Load more imported history" }
                }
            }
        }
    }
}
