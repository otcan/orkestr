//! Sends outbox items in the background, independent of which chat is open:
//! one attempt at a time per chat (in order), chats in parallel. Retries back
//! off, and start again at once when the network returns, the tab becomes
//! visible, or the owner presses Retry.
use crate::{beta_bridge, transport};
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowAdmission, ExecutionWindowQueued, ExecutionWindowState,
    ExecutionWindowStatus, Receipt, V1ThreadInput, V1ThreadInputReceipt,
};
use orkestr_v2_ui::{
    beta_inputs::SavedInput,
    beta_window::queued_notice,
    outbox::{self, Item, Outbox, Outcome, Target},
    send_intent,
    session_scope::SessionScope,
};
use serde_json::json;
use std::{cell::RefCell, collections::BTreeMap, collections::BTreeSet, rc::Rc};

const STORE: &str = include_str!("outbox_store.mjs");

pub async fn now_ms() -> f64 {
    document::eval("return Date.now();")
        .join::<f64>()
        .await
        .unwrap_or(0.0)
}

/// Wake the driver (a new Send or a manual Retry).
pub fn kick() {
    let _ = document::eval("window.dispatchEvent(new Event('orkestr-outbox')); return null;");
}

fn script(call: &str) -> String {
    format!("{}\n{call}", STORE.replace("export function", "function"))
}

async fn load(prefix: &str) -> Vec<String> {
    let eval = document::eval(&script(
        "const p = await dioxus.recv(); return loadOutbox(p);",
    ));
    if eval.send(json!(prefix)).is_err() {
        return Vec::new();
    }
    eval.join::<Vec<String>>().await.unwrap_or_default()
}

fn store(prefix: &str, changes: Vec<(String, Option<String>)>) {
    if changes.is_empty() {
        return;
    }
    let eval = document::eval(&script(
        "const [p, c] = await dioxus.recv(); storeOutbox(p, c); return null;",
    ));
    let _ = eval.send(json!([prefix, changes]));
}

async fn wait(ms: f64) -> String {
    let eval = document::eval(&script(
        "const ms = await dioxus.recv(); return await waitOutbox(ms);",
    ));
    if eval.send(json!(ms)).is_err() {
        transport::sleep(1000).await;
        return "timeout".into();
    }
    eval.join::<String>()
        .await
        .unwrap_or_else(|_| "timeout".into())
}

/// The session ended during an attempt.
struct Expired;

#[component]
pub fn OutboxDriver(
    global: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut outbox = use_context::<Signal<Outbox>>();
    let mut restored = use_signal(|| false);
    let mut mounted = use_signal(|| true);
    use_drop(move || mounted.set(false));
    let prefix = format!("orkestr.v2.outbox.{global}.");
    let written = use_hook(|| Rc::new(RefCell::new(BTreeMap::<String, String>::new())));
    let flying = use_hook(|| Rc::new(RefCell::new(BTreeSet::<String>::new())));
    // Persist unsent items whenever they change (after this owner's restore).
    let store_prefix = prefix.clone();
    use_effect(move || {
        let items = outbox.read().persistable();
        // Never write after the session changed: clearing the page's outbox
        // on sign-out or expiry must not erase this owner's stored items.
        if !restored() || !*mounted.peek() || !session_scope.peek().is_current(owner) {
            return;
        }
        let mut last = written.borrow_mut();
        let next: BTreeMap<String, String> = items.into_iter().collect();
        let mut changes = Vec::new();
        for (key, value) in &next {
            if last.get(key) != Some(value) {
                changes.push((key.clone(), Some(value.clone())));
            }
        }
        for key in last.keys() {
            if !next.contains_key(key) {
                changes.push((key.clone(), None));
            }
        }
        *last = next;
        store(&store_prefix, changes);
    });
    use_future(move || {
        let prefix = prefix.clone();
        let csrf = csrf.clone();
        let flying = flying.clone();
        async move {
            let current = move || mounted() && session_scope.read().is_current(owner);
            let raw = load(&prefix).await;
            if !current() {
                return;
            }
            let now = now_ms().await;
            outbox.write().restore(&raw, now);
            restored.set(true);
            loop {
                if !current() {
                    return;
                }
                let now = now_ms().await;
                if outbox.peek().has_expired_sent(now) {
                    outbox.write().prune(now, |_| false);
                }
                let due = outbox.peek().due_targets(now);
                for target in due {
                    let slot = target.draft_key();
                    if !flying.borrow_mut().insert(slot.clone()) {
                        continue;
                    }
                    let (csrf, flying) = (csrf.clone(), flying.clone());
                    spawn(async move {
                        let result = attempt(target, &csrf, outbox, &current).await;
                        flying.borrow_mut().remove(&slot);
                        if result.is_err() && current() {
                            onexpired.call(());
                        }
                        kick();
                    });
                }
                let pause = outbox.peek().next_due_in(now).unwrap_or(30_000.0);
                let reason = wait(pause.clamp(100.0, 30_000.0)).await;
                if matches!(reason.as_str(), "online" | "visible") {
                    let now = now_ms().await;
                    outbox.write().wake(now);
                }
            }
        }
    });
    rsx! {}
}

/// One step for the head item of `target`; the loop calls again for the next.
async fn attempt(
    target: Target,
    csrf: &str,
    mut outbox: Signal<Outbox>,
    current: &impl Fn() -> bool,
) -> Result<(), Expired> {
    let now = now_ms().await;
    let Some(item) = outbox.peek().head(&target, now).cloned() else {
        return Ok(());
    };
    let outcome = match &target {
        Target::Native(id) => native_step(&item, id, csrf).await,
        Target::V1(thread) => v1_step(&item, thread, csrf).await,
    };
    if !current() {
        return Ok(());
    }
    let outcome = outcome?;
    let now = now_ms().await;
    outbox.write().apply(&item.key, outcome, now);
    Ok(())
}

async fn native_step(item: &Item, id: &str, csrf: &str) -> Result<Outcome, Expired> {
    let Some(receipt) = item.receipt.clone() else {
        // The owner typed this in the composer: the only owner-authored web input.
        let mut body = json!({"client_message_id": item.key, "text": item.text, "author": "owner"});
        if let Some(reply_to) = &item.reply_to {
            body["reply_to"] = json!(reply_to);
        }
        let path = format!("/api/v2/conversations/{id}/messages");
        return match transport::request::<Receipt>("POST", &path, body, csrf, "").await {
            Ok(receipt) if !receipt.message_id.0.is_nil() && receipt.sequence > 0 => {
                Ok(Outcome::Saved(receipt))
            }
            Ok(_) => Ok(Outcome::Transient(
                "Receipt could not be verified; retrying.".into(),
            )),
            Err(error) if error.status == 401 => Err(Expired),
            Err(error) => Ok(outbox::intake_outcome(error.status, &error.message)),
        };
    };
    let Ok(conversation) = serde_json::from_value::<ConversationId>(json!(id)) else {
        return Ok(Outcome::Refused(
            "Conversation could not be verified.".into(),
        ));
    };
    let saved = SavedInput {
        conversation,
        input_request_key: item.key.clone(),
        receipt,
    };
    let Some(request) = item.window.clone() else {
        // Read current work: a running turn takes this as a follow-up input.
        let mut read = beta_bridge::start("GET", id, "", None);
        let response = read.recv::<beta_bridge::Reply>().await;
        beta_bridge::stop(Some(read));
        let status = match response {
            Ok(reply) if reply.status == 204 => None,
            Ok(reply) if reply.status == 200 => {
                match serde_json::from_str::<ExecutionWindowStatus>(&reply.text) {
                    Ok(status) => Some(status),
                    Err(_) => {
                        return Ok(Outcome::Transient(
                            "Saved. Work status could not be verified; retrying.".into(),
                        ))
                    }
                }
            }
            Ok(reply) if reply.status == 401 => return Err(Expired),
            _ => {
                return Ok(Outcome::Transient(
                    "Saved. Work status unavailable; retrying.".into(),
                ))
            }
        };
        if status.as_ref().is_some_and(|s| {
            !matches!(
                s.state,
                ExecutionWindowState::Active | ExecutionWindowState::Closed
            )
        }) {
            return Ok(Outcome::Wait(
                "Saved. Waiting for the current work to settle…".into(),
            ));
        }
        let Ok(key) = transport::key().await else {
            return Ok(Outcome::Transient("Secure request ID unavailable.".into()));
        };
        return Ok(match send_intent::prepare(&saved, status.as_ref(), key) {
            Ok(request) => Outcome::Prepared(request),
            Err(message) => Outcome::Transient(message.into()),
        });
    };
    let Ok(body) = serde_json::to_string(&request) else {
        return Ok(Outcome::Refused("Send could not be encoded.".into()));
    };
    let mut write = beta_bridge::start("POST", id, csrf, Some(body));
    let response = write.recv::<beta_bridge::Reply>().await;
    beta_bridge::stop(Some(write));
    let message_id = Some(saved.receipt.message_id.to_string());
    Ok(match response {
        Ok(reply) if matches!(reply.status, 200 | 201) => {
            match serde_json::from_str::<ExecutionWindowAdmission>(&reply.text) {
                Ok(receipt) if outbox::admission_matches(&request, &receipt, id) => Outcome::Sent {
                    message_id,
                    notice: if request.window_id.is_some() {
                        "Sent. Added to the running turn.".into()
                    } else {
                        "Sent. Waiting for a reply.".into()
                    },
                },
                _ => Outcome::Transient(
                    "Send confirmation could not be verified; retrying the same request.".into(),
                ),
            }
        }
        Ok(reply) if reply.status == 202 => {
            match serde_json::from_str::<ExecutionWindowQueued>(&reply.text) {
                Ok(queued) if outbox::queue_matches(&request, &queued, id) => Outcome::Sent {
                    message_id,
                    notice: queued_notice(&queued),
                },
                Ok(_) => Outcome::WindowConflict,
                Err(_) => {
                    Outcome::Transient("Queue confirmation could not be verified; retrying.".into())
                }
            }
        }
        Ok(reply) if reply.status == 401 => return Err(Expired),
        Ok(reply) if reply.status == 409 && reply.code == "restricted_conversation" => {
            Outcome::Sent {
                message_id,
                notice: "Sent to the restricted thread.".into(),
            }
        }
        Ok(reply) if reply.status == 409 => Outcome::WindowConflict,
        Ok(reply) if matches!(reply.status, 400 | 403 | 404 | 422) => Outcome::Refused(
            "Saved, but work could not start. Retry after the current work ends.".into(),
        ),
        _ => Outcome::Transient("Saved. Work not confirmed yet; retrying.".into()),
    })
}

async fn v1_step(item: &Item, thread: &str, csrf: &str) -> Result<Outcome, Expired> {
    let input = V1ThreadInput {
        client_message_id: item.key.clone(),
        text: item.text.clone(),
        attachment_ids: item.attachment_ids.clone(),
    };
    if !input.is_valid() {
        return Ok(Outcome::Refused("Message could not be prepared.".into()));
    }
    let path = format!("/api/v2/v1-threads/{thread}/messages");
    Ok(
        match transport::request::<V1ThreadInputReceipt>("POST", &path, json!(input), csrf, "")
            .await
        {
            Ok(receipt) if receipt.is_valid() && receipt.thread_id == thread => Outcome::Sent {
                message_id: Some(receipt.message_id),
                notice: if receipt.duplicate {
                    "Already delivered to V1.".into()
                } else {
                    "Sent to V1.".into()
                },
            },
            Ok(_) => Outcome::Transient("V1 receipt could not be verified; retrying.".into()),
            Err(error) if error.status == 401 => return Err(Expired),
            Err(error) => outbox::intake_outcome(error.status, &error.message),
        },
    )
}
