use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConversationProvider, SidebarEntry, SidebarSource, WhatsAppChatDirectory,
    WhatsAppChatProvision, WhatsAppChatStage,
};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    whatsapp_chat::{self, ChatForm},
};
use serde_json::{json, Value};

/// "New WhatsApp chat": a V2 conversation with a WhatsApp group of the
/// owner's numbers, wired to it on the server. Numbers, accounts and tokens
/// never reach this page; it only learns how many numbers a group gets.
#[component]
pub fn NewWhatsAppChat(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onselect: EventHandler<SidebarEntry>,
    oncreated: EventHandler<()>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut form = use_signal(ChatForm::default);
    let mut directory = use_signal(|| None::<WhatsAppChatDirectory>);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut mounted = use_signal(|| true);
    use_drop(move || mounted.set(false));
    use_future(move || async move {
        let result = crate::transport::request::<WhatsAppChatDirectory>(
            "GET",
            "/api/v2/whatsapp-chats",
            Value::Null,
            "",
            "",
        )
        .await;
        if !mounted() || !session_scope.read().is_current(owner) {
            return;
        }
        match result {
            Ok(value) => directory.set(Some(value)),
            Err(error) if error.status == 401 => onexpired.call(()),
            Err(error) => status.set(format!("New WhatsApp chats unavailable: {}", error.message)),
        }
    });
    let Some(info) = directory() else {
        return rsx! { div { class: "new-conversation new-whatsapp-chat", p { class: "sidebar-loading", if status().is_empty() { "Loading…" } else { "{status}" } } } };
    };
    if !info.available {
        return rsx! { div { class: "new-conversation new-whatsapp-chat", p { class: "sidebar-note", "New WhatsApp chats are not configured on this server." } } };
    }
    let locked = busy() || form.read().pending.is_some();
    let efforts = form.read().efforts();
    let providers = info.providers.clone();
    let numbers = info.participants;
    rsx! {
        form { class: "new-conversation new-whatsapp-chat", onsubmit: move |event| {
            event.prevent_default();
            if busy() || !session_scope.read().is_current(owner) { return; }
            busy.set(true);
            status.set("Creating the chat and its WhatsApp group…".into());
            let csrf = csrf.clone();
            spawn(async move {
                let result = async {
                    let key = crate::transport::key().await?;
                    let request = form.write().prepare(key).map_err(|m| crate::transport::Failure::from(m.to_string()))?;
                    crate::transport::request_status::<WhatsAppChatProvision>("POST", "/api/v2/whatsapp-chats", json!(request), &csrf).await
                }.await;
                if !mounted() || !session_scope.read().is_current(owner) { return; }
                busy.set(false);
                match result {
                    Ok((code, provision)) if provision.is_valid() => {
                        status.set(whatsapp_chat::status(&provision));
                        oncreated.call(());
                        if code == 201 || provision.stage >= WhatsAppChatStage::RelayPending {
                            form.set(ChatForm::default());
                            onselect.call(SidebarEntry {
                                key: format!("v2:{}", provision.conversation_id), source: SidebarSource::V2,
                                whatsapp: Some(provision.name.clone()),
                                name: provision.name, conversation_id: Some(provision.conversation_id), v1_thread_id: None,
                                parent_key: None, last_activity_ms: None, preview: None, unread: 0,
                                activity: Default::default(), read_only: false, coordinator: false, read_marker: 0,
                            });
                        }
                    }
                    Ok(_) => status.set("The server's answer could not be verified. Retry continues the same chat.".into()),
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => {
                        if matches!(error.status, 400 | 403 | 404 | 409 | 422) { form.write().refused(); }
                        status.set(error.message);
                    }
                }
            });
        },
            label { r#for: "whatsapp-chat-name", "Chat name" }
            input { id: "whatsapp-chat-name", value: "{form.read().name}", disabled: locked, maxlength: 100, placeholder: "Name of the chat and its group",
                oninput: move |e| form.write().name = e.value() }
            div { class: "field-row",
                div {
                    label { r#for: "whatsapp-chat-provider", "Provider" }
                    select { id: "whatsapp-chat-provider", disabled: locked, onchange: move |e| {
                        let mut f = form.write();
                        f.provider = ConversationProvider::parse(&e.value()).unwrap_or_default();
                        if !f.provider.efforts().contains(&f.effort.as_str()) { f.effort.clear(); }
                    },
                        for provider in providers.iter() {
                            option { value: provider.as_str(), selected: *provider == form.read().provider, "{provider.as_str()}" }
                        }
                    }
                }
                div {
                    label { r#for: "whatsapp-chat-effort", "Effort" }
                    select { id: "whatsapp-chat-effort", disabled: locked, onchange: move |e| form.write().effort = e.value(),
                        option { value: "", selected: form.read().effort.is_empty(), "default" }
                        for effort in efforts.iter() {
                            option { value: *effort, selected: form.read().effort == *effort, "{effort}" }
                        }
                    }
                }
            }
            label { r#for: "whatsapp-chat-model", "Model (optional)" }
            input { id: "whatsapp-chat-model", value: "{form.read().model}", disabled: locked, placeholder: "Installation default",
                oninput: move |e| form.write().model = e.value() }
            label { r#for: "whatsapp-chat-workspace", "Workspace (optional)" }
            input { id: "whatsapp-chat-workspace", value: "{form.read().workspace}", disabled: locked, placeholder: "/absolute/path",
                oninput: move |e| form.write().workspace = e.value() }
            p { class: "field-help", "The group gets your {numbers} WhatsApp number(s). Replies come from this Rust chat." }
            button { r#type: "submit", disabled: busy(), if busy() { "Creating…" } else if form.read().pending.is_some() { "Retry" } else { "Create WhatsApp chat" } }
            if !status().is_empty() { p { role: "status", class: "whatsapp-chat-status", "{status}" } }
        }
    }
}
