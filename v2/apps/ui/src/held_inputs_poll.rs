use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationId, HeldOwnerInputPage};
use orkestr_v2_ui::{held_inputs::HeldInputs, session_scope::SessionScope};
use serde_json::{json, Value};

#[component]
pub fn HeldInputsPanel(
    id: String,
    session_scope: Signal<SessionScope>,
    model: Signal<HeldInputs>,
    projection: Signal<orkestr_v2_ui::Projection>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut after = use_signal(|| 0i64);
    rsx! {
        div {
        button { disabled: after() == 0, onclick: move |_| after.set(0), "First held input" }
        HeldInputsPoll { key: "{id}-{after()}", id, after: after(), session_scope, model, projection, onexpired, onnext: move |cursor| after.set(cursor) }
        }
    }
}
#[component]
fn HeldInputsPoll(
    id: String,
    after: i64,
    session_scope: Signal<SessionScope>,
    mut model: Signal<HeldInputs>,
    projection: Signal<orkestr_v2_ui::Projection>,
    onexpired: EventHandler<()>,
    onnext: EventHandler<i64>,
) -> Element {
    let owner = session_scope.read().generation();
    let conversation = serde_json::from_value::<ConversationId>(json!(id)).ok();
    let read = use_hook(move || conversation.map(|id| model.write().begin(id, after)));
    let mut now = use_signal(|| 0u64);
    let channel = use_hook(move || {
        let channel = document::eval(include_str!("execution_poll.js"));
        let _ = channel.send(json!({"path":format!("/api/v2/conversations/{id}/held-inputs?after_sequence={after}&limit=50")}));
        channel
    });
    use_drop(move || {
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let read = read.clone();
        async move {
            let mut channel = channel;
            let Some(read) = read else {
                let _ = channel.send(json!({"stop":true}));
                return;
            };
            while let Ok(message) = channel.recv::<Value>().await {
                if !session_scope.read().is_current(owner) {
                    let _ = channel.send(json!({"stop":true}));
                    return;
                }
                let Some(received) = message["now"].as_u64() else {
                    continue;
                };
                now.set(received);
                match message["kind"].as_str() {
                    Some("tick") => {}
                    Some("response") if message["status"].as_u64() == Some(200) => {
                        let page =
                            serde_json::from_value::<HeldOwnerInputPage>(message["body"].clone());
                        if page
                            .ok()
                            .is_none_or(|page| model.write().apply(&read, received, page).is_err())
                        {
                            model.write().failed(&read);
                        }
                    }
                    Some("response") if matches!(message["status"].as_u64(), Some(401 | 403)) => {
                        let _ = channel.send(json!({"stop":true}));
                        onexpired.call(());
                        return;
                    }
                    _ => model.write().failed(&read),
                }
            }
            model.write().failed(&read);
        }
    });
    let next = model
        .read()
        .displayed_page()
        .and_then(|page| page.next_after_sequence);
    rsx! {
        crate::held_inputs_view::HeldInputsView { model, projection, now_ms: now() }
        button { disabled: next.is_none(), onclick: move |_| { if let Some(cursor) = next { onnext.call(cursor); } }, "Next held input" }
    }
}
