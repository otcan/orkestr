use crate::{beta_bridge, transport};
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ExecutionWindowAdmission, ExecutionWindowRequest, ExecutionWindowState, ExecutionWindowStatus,
};
use orkestr_v2_ui::{
    beta_inputs::SavedInputs, beta_window::WindowIntents, session_scope::SessionScope,
};

#[component]
pub fn WindowView(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut saved = use_context::<Signal<SavedInputs>>();
    let mut intent = use_context::<Signal<WindowIntents>>();
    let generation = session_scope.read().generation();
    let mut status = use_signal(|| None::<ExecutionWindowStatus>);
    let mut known = use_signal(|| false);
    let mut notice = use_signal(|| "Checking work window…".to_string());
    let mut busy = use_signal(|| false);
    let mut conflict = use_signal(|| false);
    let mut reading = use_signal(|| None::<document::Eval>);
    let mut writing = use_signal(|| None::<document::Eval>);
    let mut mounted = use_signal(|| true);
    use_drop(move || {
        mounted.set(false);
        beta_bridge::stop(reading());
        beta_bridge::stop(writing());
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
    let queued = saved.read().first(&id);
    let can_admit = known()
        && status.read().as_ref().is_none_or(|s| {
            matches!(
                s.state,
                ExecutionWindowState::Active | ExecutionWindowState::Closed
            )
        });
    let label = status.read().as_ref().map(|s| match s.state {
        ExecutionWindowState::Opening => "Opening work window; execution is not yet active.",
        ExecutionWindowState::Active => "Work window active. Additional admitted messages share its remaining time and limits.",
        ExecutionWindowState::Retiring => "Finishing cleanup. Saved messages remain queued.",
        ExecutionWindowState::Closed => "Work window closed. Starting again requires a separate admission.",
        ExecutionWindowState::ReconciliationRequired => "Work needs operator reconciliation. Starting again is unavailable.",
    }).unwrap_or("No work window. Send a message, then explicitly start work.");
    let review_id = id.clone();
    rsx! { section { "aria-label":"Work window",
        h3 { "Work window" }
        p { role:"status", if known() { "{label}" } else { "{notice}" } }
        p { "Work lasts up to 14½ minutes, followed by up to 30 seconds of cleanup. Accepting a result later does not restart work." }
        if let Some(input) = queued {
            p { "A saved message is waiting for admission." }
            button { disabled: busy() || (!can_admit && intent.read().pending(&id).is_none()) || conflict(), onclick: move |_| {
                if busy() || conflict() || !session_scope.read().is_current(generation) { return; }
                let input = input.clone(); let id = id.clone(); let csrf = csrf.clone();
                busy.set(true);
                spawn(async move {
                    let pending = intent.read().pending(&id).cloned();
                    let request = if let Some(request) = pending { Some(request) } else {
                        match transport::key().await {
                            Ok(key) if mounted() && session_scope.read().is_current(generation) && known() => {
                                let current = status();
                                if current.as_ref().is_some_and(|s| !matches!(s.state,ExecutionWindowState::Active|ExecutionWindowState::Closed)) { None } else {
                                    intent.write().prepare(&id, ExecutionWindowRequest {
                                        request_key:key, input_message_id:input.receipt.message_id.clone(), input_event_id:input.receipt.event_id.clone(), input_request_key:input.input_request_key.clone(),
                                        expected_generation:current.as_ref().map_or(0,|s|s.generation),
                                        window_id:current.as_ref().filter(|s|s.state==ExecutionWindowState::Active).map(|s|s.window_id),
                                        predecessor_window_id:current.as_ref().filter(|s|s.state==ExecutionWindowState::Closed).map(|s|s.window_id),
                                    })
                                }
                            }, _ => None,
                        }
                    };
                    if !mounted() || !session_scope.read().is_current(generation) { return; }
                    let Some(request) = request else { notice.set("Admission unavailable. Message remains saved.".into()); busy.set(false); return; };
                    let Some(ticket) = intent.read().ticket(&id) else { busy.set(false); return; };
                    let Ok(body) = serde_json::to_string(&request) else { busy.set(false); return; };
                    let mut channel = beta_bridge::start("POST", &id, &csrf, Some(body)); writing.set(Some(channel));
                    let reply = channel.recv::<beta_bridge::Reply>().await;
                    beta_bridge::stop(Some(channel)); writing.set(None);
                    if !mounted() || !session_scope.read().is_current(generation) || !intent.read().current(&id,&ticket) { return; }
                    match reply {
                        Ok(reply) if reply.status==200 || reply.status==201 => {
                            let receipt = serde_json::from_str::<ExecutionWindowAdmission>(&reply.text);
                            if receipt.as_ref().is_ok_and(|r| valid_status(&r.status,&id) && intent.write().complete(&id,&ticket,r,&mut saved.write())) {
                                known.set(false); notice.set("Message admitted. Checking current work status…".into());
                            } else { notice.set("Admission reply could not be verified. Retry keeps the same request.".into()); }
                        },
                        Ok(reply) if reply.status==401 => onexpired.call(()),
                        Ok(reply) if matches!(reply.status,400|403|404|409|422) => { conflict.set(true); notice.set("Admission refused. Review current status before trying a new request; message remains saved.".into()); },
                        _ => notice.set("Admission not confirmed. Retry keeps the same request; message remains saved.".into()),
                    }
                    busy.set(false);
                });
            }, if intent.read().pending(&id).is_some() { "Retry admission" } else if status.read().as_ref().is_some_and(|s|s.state==ExecutionWindowState::Active) { "Add to current work" } else { "Start work" } }
            if conflict() { button { onclick: move |_| { let ticket=intent.read().ticket(&review_id); if let Some(ticket)=ticket { intent.write().review_refusal(&review_id,&ticket); } conflict.set(false); }, "Review current status" } }
        }
        p { role:"status", "{notice}" }
    }}
}
fn valid_status(value: &ExecutionWindowStatus, id: &str) -> bool {
    value.conversation_id.to_string() == id
        && !value.window_id.is_nil()
        && value.generation > 0
        && value.generation < 9_007_199_254_740_992
        && value.limits == Default::default()
        && value.opened_at_ms >= 0
        && value.work_deadline_ms.checked_sub(value.opened_at_ms) == Some(870_000)
        && value.expires_at_ms.checked_sub(value.opened_at_ms) == Some(900_000)
}
