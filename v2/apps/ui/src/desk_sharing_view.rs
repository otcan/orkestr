use dioxus::prelude::*;
use orkestr_v2_contracts::DesktopSharing;
use orkestr_v2_ui::{desk_presentation::DeskSharing, session_scope::SessionScope};
use serde_json::json;

/// The owner's "share all desks with all chats" switch. Changing it never
/// reserves, starts or stops a desk; a refusal keeps the current setting.
#[component]
pub fn DeskSharingSwitch(
    mut sharing: Signal<Option<DesktopSharing>>,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    let Some(current) = sharing() else {
        return rsx! {};
    };
    let (shared, revision) = (current.share_all_desks, current.revision);
    rsx! {
        div { class: "desk-sharing", role: "group", "aria-label": "Desk sharing", "data-shared": if shared { "true" } else { "false" },
            p { class: "desk-sharing-state", "{DeskSharing::summary(shared)}" }
            button { r#type: "button", disabled: busy(), onclick: move |_| {
                if busy() { return; }
                busy.set(true);
                status.set(String::new());
                let csrf = csrf.clone();
                let body = json!({"expected_revision": revision, "share_all_desks": !shared});
                spawn(async move {
                    let result = crate::transport::request::<DesktopSharing>("PUT", "/api/v2/desktop-sharing", body, &csrf, "").await;
                    if !session_scope.read().is_current(owner) { return; }
                    busy.set(false);
                    match result {
                        Ok(value) => { sharing.set(Some(value)); onchanged.call(()); }
                        Err(error) if error.status == 401 => onexpired.call(()),
                        Err(error) => { status.set(error.message); onchanged.call(()); }
                    }
                });
            }, if busy() { "Saving…" } else { "{DeskSharing::switch_label(shared)}" } }
            if !status().is_empty() { p { role: "status", "{status}" } }
        }
    }
}
