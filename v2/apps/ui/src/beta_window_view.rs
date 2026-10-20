use crate::{beta_bridge, transport};
use dioxus::prelude::*;
use orkestr_v2_contracts::{ExecutionWindowState, ExecutionWindowStatus};
use orkestr_v2_ui::{beta_window::valid_status, session_scope::SessionScope};

#[component]
pub fn WindowView(
    id: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut status = use_signal(|| None::<ExecutionWindowStatus>);
    let mut known = use_signal(|| false);
    let mut notice = use_signal(|| "Checking work window…".to_string());
    let mut reading = use_signal(|| None::<document::Eval>);
    let mut mounted = use_signal(|| true);
    use_drop(move || {
        mounted.set(false);
        beta_bridge::stop(reading());
    });
    let read_id = id.clone();
    use_future(move || {
        let id = read_id.clone();
        async move {
            loop {
                let mut channel = beta_bridge::start("GET", &id, "", None);
                reading.set(Some(channel));
                let response = channel.recv::<beta_bridge::Reply>().await;
                beta_bridge::stop(Some(channel));
                reading.set(None);
                if !mounted() || !session_scope.read().is_current(generation) {
                    return;
                }
                match response {
                    Ok(reply) if reply.status == 204 => {
                        status.set(None);
                        known.set(true);
                    }
                    Ok(reply) if reply.status == 200 => {
                        match serde_json::from_str::<ExecutionWindowStatus>(&reply.text) {
                            Ok(value) if valid_status(&value, &id) => {
                                status.set(Some(value));
                                known.set(true);
                            }
                            _ => {
                                known.set(false);
                                notice.set("Work status could not be verified.".into());
                            }
                        }
                    }
                    Ok(reply) if reply.status == 401 => {
                        onexpired.call(());
                        return;
                    }
                    _ => {
                        known.set(false);
                        notice.set("Work status unavailable. Saved messages remain queued.".into());
                    }
                }
                transport::delay().await;
                if !mounted() || !session_scope.read().is_current(generation) {
                    return;
                }
            }
        }
    });
    let label = status
        .read()
        .as_ref()
        .map(|s| match s.state {
            ExecutionWindowState::Opening => "Starting",
            ExecutionWindowState::Active => "Work window active",
            ExecutionWindowState::Retiring => "Finishing cleanup",
            ExecutionWindowState::Closed => "Work window closed",
            ExecutionWindowState::ReconciliationRequired => "Work needs operator attention",
        })
        .unwrap_or("Send a message to start work");
    rsx! { section { class:"window-toolbar", "aria-label":"Work window",
        p { role:"status", if known() { "{label}" } else { "{notice}" } }
        p { "Work lasts up to 14½ minutes, followed by up to 30 seconds of cleanup. New messages share the remaining limits. Acceptance never extends a window." }
    }}
}
