use dioxus::prelude::*;
use orkestr_v2_contracts::{DesktopLeaseList, DesktopLeaseState};
use orkestr_v2_ui::session_scope::SessionScope;
use serde_json::Value;

/// Visibility over existing chat bindings and recorded leases. Opening uses
/// the existing owner link flow; reading this view never acquires a lease.
#[component]
pub fn VirtualDesks(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onsettings: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut list = use_signal(|| None::<DesktopLeaseList>);
    let mut status = use_signal(String::new);
    let mut loading = use_signal(|| true);
    let mut reload = use_signal(|| 0_u64);
    let path = format!("/api/v2/conversations/{conversation}/desktops");
    let expected = conversation.clone();
    use_resource(move || {
        let _ = reload();
        let (path, expected) = (path.clone(), expected.clone());
        async move {
            loading.set(true);
            let result =
                crate::transport::request::<DesktopLeaseList>("GET", &path, Value::Null, "", "")
                    .await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            loading.set(false);
            match result {
                Ok(value) if value.conversation_id.to_string() == expected => {
                    list.set(Some(value));
                    status.set(String::new());
                }
                Ok(_) => {
                    list.set(None);
                    status.set("The desktop response belongs to another chat.".into());
                }
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => {
                    list.set(None);
                    status.set(format!("Virtual desks unavailable: {}", error.message));
                }
            }
        }
    });
    let value = list();
    rsx! {
        section { class: "settings-section", "aria-label": "Virtual desks",
            h3 { "Virtual desks" }
            p { class: "field-help", "Desktops connected to this chat. Opening checks current viewing access; it does not create a desktop or grant agent access." }
            button { r#type: "button", disabled: loading(), onclick: move |_| reload += 1,
                if loading() { "Refreshing…" } else { "Refresh" }
            }
            button { r#type: "button", onclick: move |_| onsettings.call(()), "Configure desks" }
            if !status().is_empty() { p { role: "status", "{status}" } }
            if let Some(value) = value {
                if let Some(binding) = &value.binding {
                    p { class: "field-help",
                        if binding.grant_issued { "Agent access has been issued for this chat." }
                        else { "Agent access has not been issued for this chat. Owner viewing is checked separately." }
                    }
                    if binding.desktop_slugs.is_empty() {
                        p { "No desktops are connected to this chat." }
                    }
                    for slug in &binding.desktop_slugs {
                        {
                            let lease = value.leases.iter()
                                .filter(|lease| lease.desktop_slug == *slug && lease.conversation_id == value.conversation_id)
                                .max_by_key(|lease| (lease.acquired_at_ms, lease.heartbeat_at_ms));
                            rsx! {
                                div { class: "settings-form", key: "{slug}",
                                    ul { class: "lease-list", "aria-label": "Open {slug}",
                                        crate::desktop_open_view::DesktopOpen {
                                            key: "{conversation}:{slug}:{owner}",
                                            conversation: conversation.clone(), slug: slug.clone(),
                                            csrf: csrf.clone(), session_scope, onexpired,
                                        }
                                    }
                                    if let Some(lease) = lease {
                                        p {
                                            span { class: if lease.state == DesktopLeaseState::Active { "source-badge status-working" } else { "source-badge" },
                                                "Recorded lease: {lease.state.as_str()}"
                                            }
                                            if let Some(at) = &lease.expires_at { span { class: "field-help", " · expires {at}" } }
                                        }
                                    } else {
                                        p { class: "field-help", "No lease is recorded for this chat. This does not establish whether another chat is using the desktop." }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    p { "No desktops are connected to this chat. Configure desks in Settings to connect an existing desktop." }
                }
            } else if loading() {
                p { role: "status", "Loading connected desktops…" }
            }
        }
    }
}
