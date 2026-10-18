use crate::transport;
use dioxus::prelude::*;
use orkestr_v2_ui::Projection;

/// A separate page projection: live stream updates never replace the page being read.
#[component]
pub fn History(id: String, token: String, onexpired: EventHandler<()>) -> Element {
    let mut after = use_signal(|| 0_i64);
    let mut next = use_signal(|| None::<i64>);
    let mut page = use_signal(Projection::default);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| true);
    let mut reload = use_signal(|| 0_u64);
    use_resource(move || {
        let cursor = after();
        let _generation = reload();
        let id = id.clone();
        let token = token.clone();
        async move {
            busy.set(true);
            next.set(None);
            page.set(Projection::default());
            status.set("Loading accepted input…".into());
            match transport::history_page(&id, &token, cursor).await {
                Ok(snapshot) => {
                    let continuation = snapshot.next_cursor;
                    let mut projection = Projection::default();
                    match projection.page(snapshot) {
                        Ok(()) => {
                            page.set(projection);
                            next.set(continuation);
                            status.set(if continuation.is_some() { "More accepted input is available." } else { "End of this history page. Refresh to check for newer input." }.into());
                        }
                        Err(message) => status.set(message.into()),
                    }
                }
                Err(error) => {
                    if error.status == 401 { onexpired.call(()); }
                    status.set(error.message);
                }
            }
            busy.set(false);
        }
    });
    rsx! {
        section { "aria-label": "Accepted input history",
            h2 { "Conversation history" }
            p { "Current conversation · accepted input only. Model results and run history are unavailable." }
            p { role: "status", "{status}" }
            ol { class: "messages", "aria-live": "off",
                for message in page.read().messages.values() {
                    li { key: "{message.message_id}", strong { "{message.actor_kind}" } p { "{message.text}" } }
                }
            }
            button { disabled: busy(), onclick: move |_| { after.set(0); reload += 1; }, "From beginning" }
            button { disabled: busy() || next().is_none(), onclick: move |_| {
                if let Some(cursor) = next() { after.set(cursor); }
            }, "Next 100" }
            button { disabled: busy(), onclick: move |_| reload += 1, "Refresh page" }
        }
    }
}
