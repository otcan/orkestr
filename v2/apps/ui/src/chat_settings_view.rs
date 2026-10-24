use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettings, DesktopBinding, DesktopLeaseList, DesktopLeaseState,
};
use orkestr_v2_ui::{
    chat_settings::{slugs, SettingsForm},
    session_scope::SessionScope,
};
use serde_json::{json, Value};

/// Settings of the open native conversation: thread settings (provider,
/// model, effort, NO_REPLY, prefix/footer, review before accepting) and its V1 desktop binding with the
/// current leases. Changes are explicit saves guarded by revision.
#[component]
pub fn ChatSettings(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    rsx! {
        section { class: "chat-settings", "aria-label": "Chat settings",
            h2 { "Chat settings" }
            ThreadSettings { conversation: conversation.clone(), csrf: csrf.clone(), session_scope, onexpired }
            crate::provider_handoff_view::ProviderHandoff { conversation: conversation.clone(), csrf: csrf.clone(), session_scope, onexpired }
            Desktops { conversation: conversation.clone(), csrf: csrf.clone(), session_scope, onexpired }
            crate::restricted_view::RestrictedPanel { conversation, csrf, session_scope, onexpired }
        }
    }
}

#[component]
fn ThreadSettings(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut form = use_signal(|| None::<SettingsForm>);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut reload = use_signal(|| 0_u32);
    let path = format!("/api/v2/conversations/{conversation}/settings");
    let read_path = path.clone();
    use_resource(move || {
        let _ = reload();
        let path = read_path.clone();
        async move {
            let result = crate::transport::request::<ConversationSettings>(
                "GET",
                &path,
                Value::Null,
                "",
                "",
            )
            .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => form.set(Some(SettingsForm::from_settings(&value))),
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => status.set(format!("Settings unavailable: {}", error.message)),
            }
        }
    });
    let Some(current) = form() else {
        return rsx! { p { class: "settings-loading", if status().is_empty() { "Loading settings…" } else { "{status}" } } };
    };
    let efforts = current.provider.efforts();
    rsx! {
        form { class: "settings-form", "aria-label": "Thread settings", onsubmit: move |event| {
            event.prevent_default();
            if busy() { return; }
            let Some(update) = form.read().as_ref().map(SettingsForm::update) else { return };
            let update = match update { Ok(update) => update, Err(message) => { status.set(message.into()); return; } };
            busy.set(true);
            let (path, csrf) = (path.clone(), csrf.clone());
            spawn(async move {
                let result = crate::transport::request::<ConversationSettings>("PUT", &path, json!(update), &csrf, "").await;
                if !session_scope.read().is_current(owner) { return; }
                busy.set(false);
                match result {
                    Ok(value) => { form.set(Some(SettingsForm::from_settings(&value))); status.set(format!("Saved (revision {}). Applies from the next turn.", value.revision)); }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) if error.status == 409 => { status.set(format!("{} Reloaded the current settings.", error.message)); reload += 1; }
                    Err(error) => status.set(error.message),
                }
            });
        },
            h3 { "Thread" }
            div { class: "field-row",
                div {
                    label { r#for: "settings-provider", "Provider" }
                    select { id: "settings-provider", onchange: move |e| if let Some(f) = form.write().as_mut() { f.set_provider(ConversationProvider::parse(&e.value()).unwrap_or_default()); },
                        for provider in [ConversationProvider::Codex, ConversationProvider::Claude] {
                            option { value: provider.as_str(), selected: provider == current.provider, "{provider.as_str()}" }
                        }
                    }
                }
                div {
                    label { r#for: "settings-effort", "Effort" }
                    select { id: "settings-effort", onchange: move |e| if let Some(f) = form.write().as_mut() { f.effort = e.value(); },
                        option { value: "", selected: current.effort.is_empty(), "default" }
                        for effort in efforts.iter() {
                            option { value: *effort, selected: current.effort == *effort, "{effort}" }
                        }
                    }
                }
            }
            label { r#for: "settings-model", "Model" }
            input { id: "settings-model", value: "{current.model}", placeholder: "Installation default",
                oninput: move |e| if let Some(f) = form.write().as_mut() { f.model = e.value(); } }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.honor_no_reply, onchange: move |e| if let Some(f) = form.write().as_mut() { f.honor_no_reply = e.checked(); } }
                "Never deliver an exact NO_REPLY answer"
            }
            label { class: "checkbox",
                input { r#type: "checkbox", checked: current.review_before_accepting, onchange: move |e| if let Some(f) = form.write().as_mut() { f.review_before_accepting = e.checked(); } }
                "Review replies before accepting"
            }
            p { class: "field-help", "Off (default): replies are accepted automatically, like V1. On: each reply waits for your Accept." }
            label { r#for: "settings-prefix", "Reply prefix" }
            input { id: "settings-prefix", value: "{current.reply_prefix}", maxlength: 64,
                oninput: move |e| if let Some(f) = form.write().as_mut() { f.reply_prefix = e.value(); } }
            label { r#for: "settings-footer", "Reply footer" }
            textarea { id: "settings-footer", rows: 2, value: "{current.reply_footer}",
                oninput: move |e| if let Some(f) = form.write().as_mut() { f.reply_footer = e.value(); } }
            p { class: "field-help", "Prompts and instructions come from the chat's workspace (AGENTS.md) and are not edited here. A provider change starts the next turn on the new provider." }
            button { r#type: "submit", disabled: busy(), if busy() { "Saving…" } else { "Save settings" } }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}

#[component]
fn Desktops(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut list = use_signal(|| None::<DesktopLeaseList>);
    let mut status = use_signal(String::new);
    let mut thread = use_signal(String::new);
    let mut slug_text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut reload = use_signal(|| 0_u32);
    let read_path = format!("/api/v2/conversations/{conversation}/desktops");
    let bind_path = format!("/api/v2/conversations/{conversation}/desktop-binding");
    use_resource(move || {
        let _ = reload();
        let path = read_path.clone();
        async move {
            let result =
                crate::transport::request::<DesktopLeaseList>("GET", &path, Value::Null, "", "")
                    .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => {
                    if let Some(binding) = &value.binding {
                        thread.set(binding.v1_thread_id.clone());
                        slug_text.set(binding.desktop_slugs.join(", "));
                    }
                    list.set(Some(value));
                }
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => status.set(format!("Desktops unavailable: {}", error.message)),
            }
        }
    });
    let revision = list
        .read()
        .as_ref()
        .and_then(|l| l.binding.as_ref())
        .map_or(0, |b| b.revision);
    let leases = list
        .read()
        .as_ref()
        .map(|l| l.leases.clone())
        .unwrap_or_default();
    rsx! {
        form { class: "settings-form", "aria-label": "Desktops", onsubmit: move |event| {
            event.prevent_default();
            if busy() { return; }
            let body = json!({"expected_revision": revision, "v1_thread_id": thread().trim(), "desktop_slugs": slugs(&slug_text())});
            busy.set(true);
            let (path, csrf) = (bind_path.clone(), csrf.clone());
            spawn(async move {
                let result = crate::transport::request::<DesktopBinding>("PUT", &path, body, &csrf, "").await;
                if !session_scope.read().is_current(owner) { return; }
                busy.set(false);
                match result {
                    Ok(binding) => { status.set(format!("Desktops saved (revision {}).", binding.revision)); reload += 1; }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => { status.set(error.message); reload += 1; }
                }
            });
        },
            h3 { "Desktops" }
            p { class: "field-help", "Workers of this chat may lease these V1 desktops. Every desktop must be granted to the V1 thread in V1." }
            label { r#for: "desktop-thread", "V1 thread (grant holder)" }
            input { id: "desktop-thread", value: "{thread}", oninput: move |e| thread.set(e.value()) }
            label { r#for: "desktop-slugs", "Desktops" }
            input { id: "desktop-slugs", value: "{slug_text}", placeholder: "slug, slug", oninput: move |e| slug_text.set(e.value()) }
            button { r#type: "submit", disabled: busy() || thread().trim().is_empty() || slugs(&slug_text()).is_empty(), if busy() { "Saving…" } else { "Save desktops" } }
            h4 { "Leases" }
            if leases.is_empty() { p { class: "field-help", "No leases." } }
            ul { class: "lease-list",
                for lease in leases {
                    li { key: "{lease.v1_lease_id}",
                        strong { "{lease.desktop_slug}" }
                        span { class: if lease.state == DesktopLeaseState::Active { "source-badge status-working" } else { "source-badge" }, "{lease.state.as_str()}" }
                        if let Some(at) = lease.expires_at.clone() { span { class: "field-help", " until {at}" } }
                        if let Some(reason) = lease.end_reason.clone() { span { class: "field-help", " ({reason})" } }
                    }
                }
            }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        }
    }
}
