use crate::{beta_bridge, transport};
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettings, ExecutionWindowStatus, ProviderHandoffReceipt,
    ProviderHandoffRequest,
};
use orkestr_v2_ui::{provider_handoff::HandoffForm, session_scope::SessionScope};
use serde_json::{json, Value};

#[component]
pub fn ProviderHandoff(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut opened = use_signal(|| false);
    let mut settings = use_signal(|| None::<ConversationSettings>);
    let mut window = use_signal(|| None::<ExecutionWindowStatus>);
    let mut form = use_signal(|| None::<HandoffForm>);
    let mut pending = use_signal(|| None::<ProviderHandoffRequest>);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut reload = use_signal(|| 0_u32);
    let read_id = conversation.clone();
    use_resource(move || {
        let (enabled, _) = (opened(), reload());
        let id = read_id.clone();
        async move {
            if !enabled {
                return;
            }
            let current = transport::request::<ConversationSettings>(
                "GET",
                &format!("/api/v2/conversations/{id}/settings"),
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            let current = match current {
                Ok(value) => value,
                Err(e) if e.status == 401 => {
                    onexpired.call(());
                    return;
                }
                Err(e) => {
                    status.set(e.message);
                    return;
                }
            };
            let mut channel = beta_bridge::start("GET", &id, "", None);
            let reply = channel.recv::<beta_bridge::Reply>().await;
            beta_bridge::stop(Some(channel));
            if !session_scope.read().is_current(owner) {
                return;
            }
            let closed = reply
                .ok()
                .filter(|r| r.status == 200)
                .and_then(|r| serde_json::from_str::<ExecutionWindowStatus>(&r.text).ok())
                .filter(|w| w.conversation_id.to_string() == id);
            window.set(closed);
            if pending().is_none() {
                form.set(Some(HandoffForm::for_settings(&current)));
            }
            settings.set(Some(current));
        }
    });
    let unavailable = busy() || pending().is_some();
    rsx! {
        section { class: "provider-handoff", "aria-label": "Change provider with context",
            button { r#type: "button", onclick: move |_| opened.set(!opened()), "Change provider with context" }
            if opened() {
                p { "Start a new session with another provider and carry a reviewed history summary. Previous messages stay in history. Send a new message afterward to start work." }
                if let Some(current) = form() {
                    form { onsubmit: move |event| {
                        event.prevent_default();
                        if busy() { return; }
                        let (id, token) = (conversation.clone(), csrf.clone());
                        busy.set(true);
                        spawn(async move {
                            let request = if let Some(saved) = pending() { saved } else {
                                let (Some(current), Some(base), Some(closed)) = (form(), settings(), window()) else {
                                    busy.set(false); status.set("Wait for the previous work window to close, then reload.".into()); return;
                                };
                                let key = match transport::key().await { Ok(k) => k, Err(e) => { busy.set(false); status.set(e.message); return; } };
                                let request = match current.request(key, &base, &closed) { Ok(r) => r, Err(e) => { busy.set(false); status.set(e.into()); return; } };
                                if !session_scope.read().is_current(owner) { return; }
                                pending.set(Some(request.clone())); request
                            };
                            if !session_scope.read().is_current(owner) { return; }
                            let result = transport::request::<ProviderHandoffReceipt>("POST", &format!("/api/v2/conversations/{id}/provider-handoffs"), json!(request), &token, "").await;
                            if !session_scope.read().is_current(owner) { return; }
                            busy.set(false);
                            match result {
                                Ok(receipt) if receipt.conversation_id.to_string() == id && receipt.window_id == request.window_id && receipt.generation == request.generation && receipt.to_provider == request.target_provider => {
                                    pending.set(None); status.set(format!("Provider changed. History summary saved; no work started (revision {}).", receipt.settings_revision)); reload += 1;
                                }
                                Ok(_) => status.set("The decision receipt could not be verified. Retry keeps the same request.".into()),
                                Err(e) if e.status == 401 => onexpired.call(()),
                                Err(e) if e.status == 0 || e.status >= 500 || matches!(e.status, 408 | 429) => status.set("Outcome unknown. Retry keeps exactly the same change and summary.".into()),
                                Err(e) => { pending.set(None); status.set(e.message); reload += 1; }
                            }
                        });
                    },
                        label { "Target provider" }
                        select { disabled: unavailable, onchange: move |e| if let Some(f) = form.write().as_mut() { if let Some(p) = ConversationProvider::parse(&e.value()) { f.select(p); } },
                            for p in [ConversationProvider::Codex, ConversationProvider::Claude] { option { value: p.as_str(), selected: p == current.provider, "{p.as_str()}" } }
                        }
                        label { "Model" }
                        input { value: "{current.model}", disabled: unavailable, oninput: move |e| if let Some(f) = form.write().as_mut() { f.model=e.value(); } }
                        label { "Effort" }
                        select { disabled: unavailable, onchange: move |e| if let Some(f) = form.write().as_mut() { f.effort=e.value(); },
                            for effort in current.provider.efforts() { option { value: *effort, selected: current.effort == *effort, "{effort}" } }
                        }
                        label { "Reviewed history summary" }
                        textarea { value: "{current.history}", disabled: unavailable, oninput: move |e| if let Some(f) = form.write().as_mut() { f.history=e.value(); } }
                        label { input { r#type: "checkbox", checked: current.acknowledged, disabled: unavailable, onchange: move |e| if let Some(f) = form.write().as_mut() { f.acknowledged=e.checked(); } } "I reviewed the summary and want a new session with this provider." }
                        button { r#type: "submit", disabled: busy(), if pending().is_some() { "Retry same change" } else { "Change provider" } }
                        button { r#type: "button", disabled: unavailable, onclick: move |_| reload += 1, "Reload current state" }
                    }
                }
                p { role: "status", "{status}" }
            }
        }
    }
}
