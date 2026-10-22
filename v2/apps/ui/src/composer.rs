use dioxus::prelude::*;
use orkestr_v2_ui::{
    composer_attachments::Attached,
    outbox::{Outbox, Target},
    session_scope::SessionScope,
    Draft,
};
use std::collections::BTreeMap;

/// Owner composer of a native conversation. Send never waits: each message
/// goes to the outbox (its own key, its own state in the timeline) and the
/// composer is free for the next one at once. A message sent while a turn
/// runs joins that turn as a follow-up input.
#[component]
pub fn Composer(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut drafts: Signal<BTreeMap<String, Draft>>,
    onexpired: EventHandler<()>,
) -> Element {
    let _ = onexpired;
    let owner = session_scope.read().generation();
    let outbox = use_context::<Signal<Outbox>>();
    let status = use_signal(String::new);
    let attached = use_signal(Vec::<Attached>::new);
    let text = drafts
        .read()
        .get(&id)
        .map(|d| d.text.clone())
        .unwrap_or_default();
    let input_id = id.clone();
    let attach_id = id.clone();
    let preview_id = id.clone();
    rsx! {
        crate::outbox_view::ReplyPreview { draft_key: preview_id }
        form { class: "message-composer", onsubmit: move |event| {
            event.prevent_default();
            if !session_scope.read().is_current(owner) { return; }
            crate::outbox_view::submit(Target::Native(id.clone()), drafts, attached, outbox, status);
        },
            label { r#for: "composer", "Message" }
            textarea { id: "composer", rows: 3, value: "{text}", "aria-describedby": "composer-help",
                oninput: move |event| { if session_scope.read().is_current(owner) { drafts.write().entry(input_id.clone()).or_default().edit(event.value()); } }
            }
            crate::composer_tools::AttachTools { target: crate::composer_tools::AttachTarget::Native(attach_id.clone()), csrf: csrf.clone(), attached, disabled: false }
            crate::composer_tools::EnterSend { id: "composer" }
            p { id: "composer-help", "Enter sends · Shift+Enter adds a new line. You can keep sending; each message shows its own state." }
            button { r#type: "submit", "Send" }
            if !status().is_empty() { p { class: "composer-notice", role: "status", "{status}" } }
        }
    }
}
