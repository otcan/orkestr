use dioxus::prelude::*;
use orkestr_v2_contracts::{SidebarEntry, SidebarPage, SidebarSource, SidebarV1Status};
use orkestr_v2_ui::{
    conversation_directory::{ConversationSummary, Creation},
    session_scope::SessionScope,
    sidebar,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
struct Reply {
    status: u16,
    text: String,
}
fn start(input: Value) -> document::Eval {
    let source =
        include_str!("conversation_request.mjs").replace("export async function", "async function");
    let script=format!("{source}\nconst input=await dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await conversationRequest({{...input,signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(input);
    eval
}

/// Sidebar refresh interval: live activity and new replies appear within it.
const POLL_MS: u32 = 4000;

/// Messaging-style list of native conversations and linked V1 chats, newest
/// activity first, sub-chats grouped under their parent. Selecting a row is
/// navigation only; it never admits work.
#[component]
pub fn ConversationSidebar(
    selected: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onselect: EventHandler<SidebarEntry>,
    onloaded: EventHandler<Vec<SidebarEntry>>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut page = use_signal(|| None::<SidebarPage>);
    let mut tick = use_signal(|| 0_u64);
    let mut writing = use_signal(|| None::<document::Eval>);
    let mut notice = use_signal(String::new);
    let mut create = use_signal(Creation::default);
    let mut open = use_signal(|| false);
    let mut open_whatsapp = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut filter = use_signal(String::new);
    let mut expanded = use_signal(BTreeSet::<String>::new);
    // Last mark sent per entry, so a poll never repeats a write.
    let mut marked = use_signal(BTreeMap::<String, i64>::new);
    let statuses = use_signal(
        std::collections::BTreeMap::<String, orkestr_v2_ui::conversation_status::RowStatus>::new,
    );
    let slots = use_signal(|| None::<orkestr_v2_ui::conversation_status::Slots>);
    use_drop(move || {
        mounted.set(false);
        if let Some(channel) = writing() {
            let _ = channel.send(json!({"stop":true}));
        }
    });
    use_future(move || async move {
        loop {
            crate::transport::sleep(POLL_MS).await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            tick += 1;
        }
    });
    // Props do not re-run hooks: follow the selection and refresh at once.
    let mut current_key = use_signal(|| selected.clone());
    use_effect(use_reactive((&selected,), move |(selected,)| {
        if *current_key.peek() != selected {
            current_key.set(selected);
            tick += 1;
        }
    }));
    let csrf_for_marks = csrf.clone();
    use_resource(move || {
        let _ = tick();
        let selected = current_key.peek().clone();
        let csrf = csrf_for_marks.clone();
        async move {
            let result = crate::transport::request::<SidebarPage>(
                "GET",
                "/api/v2/sidebar",
                Value::Null,
                "",
                "",
            )
            .await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) if sidebar::valid(&value) => {
                    onloaded.call(value.entries.clone());
                    let mark = value
                        .entries
                        .iter()
                        .find(|e| e.key == selected)
                        .map(|e| (e.key.clone(), e.read_marker, e.unread));
                    page.set(Some(value));
                    notice.set(String::new());
                    // The open conversation is read up to what this poll saw.
                    if let Some((key, marker, unread)) = mark {
                        let known = marked.peek().get(&key).copied();
                        if known.is_none_or(|k| marker > k) || unread > 0 {
                            marked.write().insert(key.clone(), marker);
                            let _ = crate::transport::request::<Value>(
                                "PUT",
                                "/api/v2/sidebar/read",
                                json!({"key": key, "marker": marker}),
                                &csrf,
                                "",
                            )
                            .await;
                        }
                    }
                }
                Ok(_) => notice.set("Conversation list could not be verified.".into()),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(_) => notice.set("Conversations unavailable. Retrying…".into()),
            }
        }
    });
    let now = page.read().as_ref().map_or(0, |p| p.observed_at_ms);
    let v1_note = page.read().as_ref().and_then(|p| match p.v1_status {
        SidebarV1Status::Unavailable => Some("V1 chats are unavailable right now."),
        SidebarV1Status::MapOnly => Some("V1 chats from the live map only."),
        _ => None,
    });
    let query = filter().trim().to_lowercase();
    let visible: Vec<sidebar::Row> = page
        .read()
        .as_ref()
        .map(|p| {
            if query.is_empty() {
                sidebar::rows(&p.entries, &expanded.read(), &selected)
            } else {
                // Search lists matches flat, newest first.
                p.entries
                    .iter()
                    .filter(|e| {
                        e.name.to_lowercase().contains(&query)
                            || e.whatsapp
                                .as_ref()
                                .is_some_and(|g| g.to_lowercase().contains(&query))
                    })
                    .map(|e| sidebar::Row {
                        entry: e.clone(),
                        depth: 0,
                        descendants: 0,
                        group_activity_ms: e.last_activity_ms,
                        hidden_unread: 0,
                        hidden_activity: false,
                        expanded: false,
                    })
                    .collect()
            }
        })
        .unwrap_or_default();
    let ids: Vec<String> = page
        .read()
        .as_ref()
        .map(|p| {
            p.entries
                .iter()
                .filter_map(|e| e.conversation_id.as_ref().map(ToString::to_string))
                .take(50)
                .collect()
        })
        .unwrap_or_default();
    // A list item, so a changed page always remounts the poller with its new ids.
    let poll_key = format!("{owner}-{}", ids.join(","));
    rsx! { aside { class:"conversation-sidebar", "aria-label":"Conversations",
        div { class:"sidebar-heading",
            h2 {"Chats"}
            div { class:"new-actions",
                button { class:"new-chat", "aria-expanded":"{open}", onclick:move |_|{open.set(!open());open_whatsapp.set(false);}, "New conversation" }
                button { class:"new-chat new-whatsapp", "aria-expanded":"{open_whatsapp}", onclick:move |_|{open_whatsapp.set(!open_whatsapp());open.set(false);}, "New WhatsApp chat" }
            }
        }
        if open_whatsapp() {
            crate::new_whatsapp_chat::NewWhatsAppChat { csrf: csrf.clone(), session_scope, onexpired,
                oncreated: move |_| tick += 1,
                onselect: move |entry: SidebarEntry| { open_whatsapp.set(false); onselect.call(entry); } }
        }
        if open() {
            form { class:"new-conversation", onsubmit:move |event|{
                event.prevent_default();if busy()||!session_scope.read().is_current(owner){return;}
                busy.set(true);let csrf=csrf.clone();
                spawn(async move {
                    let result=async {
                        let key=crate::transport::key().await?;
                        if !mounted()||!session_scope.read().is_current(owner){return Ok(None);}
                        let request=create.write().prepare(key).map_err(|m|crate::transport::Failure::from(m.to_string()))?;
                        let body=serde_json::to_string(&request).map_err(|_|crate::transport::Failure::from("Conversation request unavailable.".to_string()))?;
                        let channel=start(json!({"method":"POST","body":body,"csrf":csrf}));writing.set(Some(channel));
                        let reply=channel.join::<Reply>().await.map_err(|_|crate::transport::Failure::from("Creation not confirmed. Retry keeps the same request.".to_string()))?;
                        if !mounted()||!session_scope.read().is_current(owner){return Ok(None);}
                        if reply.status==401{onexpired.call(());return Ok(None);}
                        if ![200,201].contains(&reply.status){
                            if matches!(reply.status,400|403|404|409|422){create.write().pending=None;}
                            return Err(crate::transport::Failure::from("Conversation not created. Review the name or retry the same request.".to_string()));
                        }
                        let row=serde_json::from_str::<ConversationSummary>(&reply.text).map_err(|_|crate::transport::Failure::from("Creation reply could not be verified.".to_string()))?;
                        if !create.read().confirmed(&row){return Err(crate::transport::Failure::from("Creation reply does not match this conversation.".to_string()));}
                        Ok(Some(row))
                    }.await;
                    if !mounted()||!session_scope.read().is_current(owner){return;}
                    writing.set(None);busy.set(false);
                    match result {
                        Ok(Some(row))=>{
                            create.set(Creation::default());open.set(false);tick+=1;
                            onselect.call(SidebarEntry {
                                key: format!("v2:{}", row.conversation_id), source: SidebarSource::V2,
                                name: row.name, conversation_id: Some(row.conversation_id), v1_thread_id: None,
                                parent_key: None, last_activity_ms: None, preview: None, unread: 0,
                                activity: Default::default(), read_only: false, coordinator: false,
                                read_marker: row.last_sequence, whatsapp: None,
                            });
                        },
                        Ok(None)=>{}, Err(error)=>notice.set(error.message) }
                });
            },
                label {r#for:"conversation-name","Conversation name"}
                input {id:"conversation-name",value:"{create.read().name}",disabled:busy()||create.read().pending.is_some(),oninput:move|e|create.write().name=e.value(),placeholder:"What are you working on?"}
                button {r#type:"submit",disabled:busy(),if busy(){"Creating…"}else if create.read().pending.is_some(){"Retry creation"}else{"Create conversation"}}
            }
        }
        div { class:"sidebar-search",
            label { r#for:"conversation-filter", class:"visually-hidden", "Search chats" }
            input { id:"conversation-filter", r#type:"search", placeholder:"Search chats", value:"{filter}", oninput:move|e|filter.set(e.value()) }
        }
        for key in [poll_key] { crate::conversation_status_poll::StatusPoll { key:"{key}", ids: ids.clone(), session_scope, statuses, slots, onexpired } }
        nav { class:"conversation-list", "aria-label":"Conversation list",
            for row in visible {
                SidebarRow {
                    key:"{row.entry.key}", row: row.clone(), now, selected: row.entry.key == selected,
                    status: row.entry.conversation_id.as_ref().and_then(|id| statuses.read().get(&id.to_string()).cloned()),
                    ontoggle: move |key: String| { let mut set = expanded.write(); if !set.remove(&key) { set.insert(key); } },
                    onselect: move |entry: SidebarEntry| { if session_scope.read().is_current(owner) { onselect.call(entry); } },
                }
            }
            if page.read().is_none() && notice().is_empty() { p { class:"sidebar-loading", "Loading chats…" } }
        }
        if let Some(note) = v1_note { p { class:"sidebar-note", "{note}" } }
        p {role:"status", class:"sidebar-notice", "{notice}"}
    }}
}

#[component]
fn SidebarRow(
    row: sidebar::Row,
    now: i64,
    selected: bool,
    status: Option<orkestr_v2_ui::conversation_status::RowStatus>,
    ontoggle: EventHandler<String>,
    onselect: EventHandler<SidebarEntry>,
) -> Element {
    let entry = row.entry.clone();
    let time = sidebar::relative_time(now, row.group_activity_ms);
    let activity = sidebar::activity_label(&entry.activity).or_else(|| {
        row.hidden_activity
            .then(|| "sub-chat thinking…".to_string())
    });
    let unread = sidebar::unread_label(if selected {
        row.hidden_unread
    } else {
        entry.unread + row.hidden_unread
    });
    let preview = entry.preview.as_ref().map(|p| {
        let who = match p.author {
            orkestr_v2_contracts::SidebarAuthor::Owner => "You: ",
            _ => "",
        };
        format!("{who}{}", p.text)
    });
    let v1 = entry.source == SidebarSource::V1;
    let key = entry.key.clone();
    rsx! {
        div { class: "conversation-row", "data-depth": "{row.depth}", "data-source": if v1 { "v1" } else { "v2" },
            "data-unread": if unread.is_some() { "true" } else { "false" },
            button { class: "conversation-choice", r#type: "button", "aria-current": if selected { "page" } else { "false" },
                onclick: { let entry = entry.clone(); move |_| onselect.call(entry.clone()) },
                Avatar { name: entry.name.clone(), thread: entry.v1_thread_id.clone() }
                span { class: "choice-body",
                    span { class: "choice-top",
                        span { class: "conversation-name", "{entry.name}" }
                        if !time.is_empty() { time { class: "choice-time", "{time}" } }
                    }
                    span { class: "choice-bottom",
                        if let Some(label) = activity.clone() {
                            span { class: "choice-activity", "{label}" }
                        } else if let Some(text) = preview.clone() {
                            span { class: "choice-preview", "{text}" }
                        } else {
                            span { class: "choice-preview choice-empty", if v1 { "Linked V1 chat" } else { "No messages yet" } }
                        }
                        if let Some(count) = unread.clone() { span { class: "unread-badge", "aria-label": "{count} unread", "{count}" } }
                    }
                    span { class: "choice-badges",
                        if let Some(group) = entry.whatsapp.clone() {
                            span { class: "source-badge whatsapp-badge", title: "WhatsApp group: {group}", "aria-label": "WhatsApp group {group}",
                                if group == entry.name { "WhatsApp" } else { "WhatsApp · {group}" } }
                        }
                        if v1 { span { class: "source-badge", "On V1" } }
                        if entry.coordinator { span { class: "source-badge coordinator-badge", "Coordinator" } }
                        if let Some(status) = status.clone() { span { class: "conversation-status {status.tone.class()}", "{status.label}" } }
                    }
                }
            }
            if row.descendants > 0 {
                button { class: "group-toggle", r#type: "button", "aria-expanded": "{row.expanded}",
                    "aria-label": if row.expanded { "Hide sub-chats of {entry.name}" } else { "Show {row.descendants} sub-chats of {entry.name}" },
                    onclick: move |_| ontoggle.call(key.clone()),
                    span { class: "toggle-count", "{row.descendants}" } span { "aria-hidden": "true", if row.expanded { " ▾" } else { " ▸" } }
                }
            }
        }
    }
}

/// The chat's Orkestr icon from the V1 app (served by the V2 server for any
/// chat with a V1 thread, including imported ones); initials otherwise.
#[component]
pub fn Avatar(name: String, thread: Option<String>) -> Element {
    let mut failed = use_signal(|| None::<String>);
    let initial: String = name
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "#".into());
    match thread.filter(|t| failed.read().as_deref() != Some(t.as_str())) {
        Some(thread) => rsx! {
            img { class: "avatar avatar-icon", src: "/api/v2/thread-icons/{thread}", alt: "", "aria-hidden": "true",
                loading: "lazy", decoding: "async", onerror: move |_| failed.set(Some(thread.clone())) }
        },
        None => rsx! { span { class: "avatar", "aria-hidden": "true", "{initial}" } },
    }
}
