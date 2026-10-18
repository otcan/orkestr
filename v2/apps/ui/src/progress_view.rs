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
) -> Element {
    let mut output = use_signal(|| None::<String>);
    let mut notice = use_signal(|| "Loading provider output…".to_string());
    let mut busy = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    let owner = session_scope.read().generation();
    let selection = execution.read().selection_generation();
    let status_for_load = status.clone();
    use_drop(move || {
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
            let eval = document::eval(include_str!("payload_request.js"));
            let _=eval.send(json!({"method":"GET","path":format!("/api/v2/conversations/{}/payloads/{}",status.conversation_id,progress.payload_id)}));
            channel.set(Some(eval));
            let response = eval.join::<Value>().await;
            if !session_scope.read().is_current(owner)
                || execution.read().selection_generation() != selection
            {
                return;
            }
            channel.set(None);
            busy.set(false);
            match response {
                Ok(value) if matches!(value["status"].as_u64(), Some(401 | 403)) => {
                    onexpired.call(());
                }
                Ok(value) if value["status"] == 200 => {
                    let payload = serde_json::from_value::<ProviderPayload>(value["body"].clone());
                    match payload {
                        Ok(payload)
                            if payload.conversation_id == status.conversation_id
                                && Some(&payload.run_id) == status.run_id.as_ref()
                                && payload.payload_id == progress.payload_id =>
                        {
                            notice.set(
                                if payload.text.is_some() {
                                    "Provider output; review before accepting."
                                } else {
                                    "Provider output removed."
                                }
                                .into(),
                            );
                            output.set(payload.text);
                        }
                        _ => notice.set("Provider output unavailable.".into()),
                    }
                }
                _ => notice.set("Provider output unavailable. Reconnect to retry.".into()),
            }
        }
    });
    rsx! {
        section { "aria-label":"Provider output",
            p { role:"status", "{notice}" }
            if let Some(text)=output() { pre { "{text}" } }
            if output().is_some() {
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
                            Ok(value) if value["status"]==204=>{output.set(None);notice.set("Provider output removed.".into());}
                            Ok(value) if matches!(value["status"].as_u64(),Some(401|403))=>onexpired.call(()),
                            _=>notice.set("Removal not confirmed. Retry keeps the same output selected.".into()),
                        }
                    });
                }, "Remove provider output" }
            }
        }
    }
}
