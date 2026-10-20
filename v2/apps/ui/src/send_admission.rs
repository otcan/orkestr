use crate::{
    beta_bridge,
    transport::{self, Failure},
};
use dioxus::prelude::*;
use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowStatus};
use orkestr_v2_ui::{
    beta_inputs::{SavedInput, SavedInputs},
    beta_window::{valid_status, WindowIntents},
    send_intent,
    session_scope::SessionScope,
};
use std::{cell::Cell, rc::Rc};

pub struct SendScope {
    pub session: Signal<SessionScope>,
    pub owner: u64,
    pub live: Rc<Cell<bool>>,
    pub intents: Signal<WindowIntents>,
    pub saved: Signal<SavedInputs>,
    pub channel: Signal<Option<document::Eval>>,
}

pub async fn admit(input: SavedInput, csrf: String, scope: SendScope) -> Result<(), Failure> {
    let SendScope {
        session,
        owner,
        live,
        mut intents,
        mut saved,
        mut channel,
    } = scope;
    let current = || live.get() && session.read().is_current(owner);
    let id = input.conversation.to_string();
    if !current() {
        return Err("Conversation changed. Retry the saved message there."
            .to_string()
            .into());
    }
    let retained = intents.read().pending(&id).cloned();
    let request = if let Some(request) = retained {
        if !send_intent::same_input(&request, &input) {
            return Err("Another send needs review in this conversation."
                .to_string()
                .into());
        }
        request
    } else {
        let mut read = beta_bridge::start("GET", &id, "", None);
        channel.set(Some(read));
        let response = read.recv::<beta_bridge::Reply>().await;
        beta_bridge::stop(Some(read));
        if !current() {
            return Err("Conversation changed. Retry the saved message there."
                .to_string()
                .into());
        }
        channel.set(None);
        let status = match response {
            Ok(reply) if reply.status == 204 => None,
            Ok(reply) if reply.status == 200 => Some(
                serde_json::from_str::<ExecutionWindowStatus>(&reply.text).map_err(|_| {
                    Failure::from("Work status could not be verified. Message saved.".to_string())
                })?,
            ),
            Ok(reply) if reply.status == 401 => {
                return Err(Failure {
                    status: 401,
                    message: "Sign in again to send the saved message.".into(),
                })
            }
            _ => {
                return Err("Work status unavailable. Message saved; retry Send."
                    .to_string()
                    .into())
            }
        };
        let key = transport::key().await?;
        if !current() {
            return Err("Conversation changed. Retry the saved message there."
                .to_string()
                .into());
        }
        let next = send_intent::prepare(&input, status.as_ref(), key)
            .map_err(|m| Failure::from(m.to_string()))?;
        intents.write().prepare(&id, next).ok_or_else(|| {
            Failure::from("Send could not be retained. Message saved.".to_string())
        })?
    };
    if !current() || !send_intent::same_input(&request, &input) {
        return Err("Send scope changed. Message remains saved."
            .to_string()
            .into());
    }
    let ticket = intents
        .read()
        .ticket(&id)
        .ok_or_else(|| Failure::from("Send needs review.".to_string()))?;
    let body = serde_json::to_string(&request)
        .map_err(|_| Failure::from("Send could not be encoded.".to_string()))?;
    let mut write = beta_bridge::start("POST", &id, &csrf, Some(body));
    channel.set(Some(write));
    let result = write.recv::<beta_bridge::Reply>().await;
    beta_bridge::stop(Some(write));
    if !current() {
        return Err("Conversation changed. Retry the original send there."
            .to_string()
            .into());
    }
    channel.set(None);
    if !intents.read().current(&id, &ticket) {
        return Err("Send changed while waiting. Review current work."
            .to_string()
            .into());
    }
    match result {
        Ok(reply) if matches!(reply.status, 200 | 201) => {
            let receipt = serde_json::from_str::<ExecutionWindowAdmission>(&reply.text);
            if receipt.as_ref().is_ok_and(|receipt| {
                valid_status(&receipt.status, &id)
                    && intents
                        .write()
                        .complete(&id, &ticket, receipt, &mut saved.write())
            }) {
                Ok(())
            } else {
                Err(
                    "Send confirmation could not be verified. Retry keeps the original request."
                        .to_string()
                        .into(),
                )
            }
        }
        Ok(reply) if reply.status == 401 => Err(Failure {
            status: 401,
            message: "Sign in again to check this send.".into(),
        }),
        Ok(reply) if matches!(reply.status, 400 | 403 | 404 | 409 | 422) => {
            intents.write().mark_refused(&id, &ticket);
            Err("Work could not start. Finish or stop existing work, then Review and retry send. Your message is saved.".to_string().into())
        }
        _ => Err(
            "Send not confirmed. Retry keeps the original message and work request."
                .to_string()
                .into(),
        ),
    }
}
