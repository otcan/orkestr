use dioxus::prelude::*;
use orkestr_v2_contracts::{ExecutionStatus, ProviderPayload};
use orkestr_v2_ui::{execution::Execution, session_scope::SessionScope};
use serde_json::{json, Value};
#[component]
pub fn ProgressView(
    status: ExecutionStatus,
    csrf: String,
    execution: Signal<Execution>,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    /// Chat view: the answer as a normal assistant message, without review
    /// controls or provider wording.
    #[props(default)]
    plain: bool,
) -> Element {
    let phase = status.phase;
    let mut output = use_signal(orkestr_v2_ui::payload::Output::default);
    let mut output_reference = use_signal(|| None::<(String, String, String)>);
    let mut notice = use_signal(|| "Loading provider output…".to_string());
    let mut busy = use_signal(|| false);
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut read_channel = use_signal(|| None::<document::Eval>);
    let owner = session_scope.read().generation();
    let selection = execution.read().selection_generation();
    let status_for_load = status.clone();
    use_drop(move || {
        if let Some(eval) = read_channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_future(move || {
        let status = status_for_load.clone();
        async move {
            let Some(progress) = status.progress.as_ref() else {
                return;
            };
            let eval = document::eval(include_str!("payload_poll.js"));
            let _=eval.send(json!({"method":"GET","path":format!("/api/v2/conversations/{}/payloads/{}",status.conversation_id,progress.payload_id)}));
            read_channel.set(Some(eval));
            let mut eval = eval;
            while let Ok(value) = eval.recv::<Value>().await {
                if value["kind"] == "tick" {
                    continue;
                }
                let response = Ok::<Value, ()>(value);
                if !session_scope.read().is_current(owner)
                    || execution.read().selection_generation() != selection
                {
                    let _ = eval.send(json!({"stop":true}));
                    return;
                }
                match response {
                    Ok(value) if matches!(value["status"].as_u64(), Some(401 | 403)) => {
                        output.write().unavailable();
                        let _ = eval.send(json!({"stop":true}));
                        onexpired.call(());
                        return;
                    }
                    Ok(value) if value["status"] == 200 => {
                        let payload =
                            serde_json::from_value::<ProviderPayload>(value["body"].clone());
                        match payload {
                            Ok(payload)
                                if payload.conversation_id == status.conversation_id
                                    && Some(&payload.run_id) == status.run_id.as_ref()
                                    && payload.payload_id == progress.payload_id =>
                            {
                                output_reference.set(Some((
                                    payload.conversation_id.to_string(),
                                    payload.run_id.to_string(),
                                    payload.payload_id.to_string(),
                                )));
                                notice.set(
                                    if payload.text.is_some() && !output.read().removed() {
                                        "Provider output; review before accepting."
                                    } else {
                                        "Provider output removed."
                                    }
                                    .into(),
                                );
                                output.write().observed(payload.text);
                            }
                            _ => {
                                output.write().unavailable();
                                notice.set("Provider output unavailable.".into());
                            }
                        }
                    }
                    _ => {
                        output.write().unavailable();
                        notice.set("Provider output unavailable. Retrying…".into());
                    }
                }
            }
        }
    });
    if plain {
        use orkestr_v2_contracts::ExecutionPhase::*;
        let state = match phase {
            Queued | Starting | Running => "Writing…",
            CancelRequested => "Stopping…",
            Cancelled => "Stopped",
            Failed | Blocked => "Not finished",
            AwaitingAcceptance | Completed => "",
        };
        let text = output.read().text.clone();
        return rsx! {
            article { class: "assistant-message live-answer", "aria-label": "Assistant answer",
                strong { "Assistant" }
                if let Some(text) = text {
                    crate::rich_text_view::RichText { text }
                }
                if !state.is_empty() { p { class: "reply-state", "{state}" } }
            }
        };
    }
    rsx! {
        section { "aria-label":"Provider output",
            p { role:"status", "{notice}" }
            if let (Some(text), Some((conversation, run, payload))) =
                (output.read().text.clone(), output_reference.read().clone()) {
                pre {
                    "data-conversation-id": "{conversation}",
                    "data-run-id": "{run}",
                    "data-payload-id": "{payload}",
                    "{text}"
                }
            }
            if output.read().text.is_some() {
                button { r#type:"button", disabled:busy(), onclick:move |_| {
                    if busy() || !session_scope.read().is_current(owner) {return;}
                    let status=status.clone();let csrf=csrf.clone();busy.set(true);
                    spawn(async move {
                        let Some(progress)=status.progress.as_ref() else{return;};
                        let eval=document::eval(include_str!("payload_request.js"));
                        let _=eval.send(json!({"method":"DELETE","path":format!("/api/v2/conversations/{}/payloads/{}",status.conversation_id,progress.payload_id),"csrf":csrf}));channel.set(Some(eval));
                        let response=eval.join::<Value>().await;
                        if !session_scope.read().is_current(owner) || execution.read().selection_generation()!=selection {return;}
                        busy.set(false);channel.set(None);
                        match response {
                            Ok(value) if value["status"]==204=>{output.write().observed(None);notice.set("Provider output removed.".into());}
                            Ok(value) if matches!(value["status"].as_u64(),Some(401|403))=>onexpired.call(()),
                            _=>notice.set("Removal not confirmed. Retry keeps the same output selected.".into()),
                        }
                    });
                }, "Remove provider output" }
            }
        }
    }
}
