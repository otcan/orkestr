use dioxus::prelude::*;
use orkestr_v2_ui::{
    session_scope::SessionScope,
    timer_labels::utc_time,
    timer_rules::{pause_body, RuleForm},
    timers::{full_listing, valid_namespace, Detail, Listed, Listing},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

#[component]
pub fn Timers(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut entered = use_signal(String::new);
    let mut selected = use_signal(String::new);
    let owner = session_scope.read().generation();
    let mut timers = use_signal(|| None::<Listing>);
    let mut list_notice = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let mut now_ms = use_signal(|| 0_i64);
    let mut editor = use_signal(|| None::<RuleForm>);
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    let list_conversation = conversation.clone();
    use_resource(move || {
        let conversation = list_conversation.clone();
        let _ = reload();
        async move {
            now_ms.set(crate::timer_bridge::now_ms().await);
            let path = format!("/api/v2/conversations/{conversation}/timers");
            let result =
                crate::transport::request::<Value>("GET", &path, Value::Null, "", "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => match full_listing(&value, &conversation) {
                    Some(rows) => {
                        list_notice.set(String::new());
                        timers.set(Some(rows))
                    }
                    None => list_notice.set("Timer list could not be verified.".into()),
                },
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) => list_notice.set(format!("Timer list unavailable: {}", error.message)),
            }
        }
    });
    // One write at a time; a refusal reloads the list so the screen never lies.
    let write = {
        let csrf = csrf.clone();
        Callback::new(
            move |(method, path, body, done): (&'static str, String, Value, &'static str)| {
                if busy() {
                    return;
                }
                busy.set(true);
                let csrf = csrf.clone();
                spawn(async move {
                    let result = crate::timer_bridge::call(method, &path, &csrf, body).await;
                    if !session_scope.read().is_current(owner) {
                        return;
                    }
                    busy.set(false);
                    match result {
                        Ok(reply) if reply.ok() => status.set(done.into()),
                        Ok(reply) if matches!(reply.status, 401 | 403) => onexpired.call(()),
                        Ok(reply) => status.set(reply.failure()),
                        Err(message) => status.set(message),
                    }
                    reload += 1;
                });
            },
        )
    };
    let chat_pause = timers.read().as_ref().and_then(|l| l.pause_until_ms);
    let chat_local = timers
        .read()
        .as_ref()
        .and_then(|l| l.pause_until_local.clone());
    let chat_paused = chat_pause.is_some_and(|until| until > now_ms());
    let pause_chat_path = format!("/api/v2/conversations/{conversation}/timer-pause");
    let resume_chat_path = pause_chat_path.clone();
    rsx! {
        section { class: "timers-screen", "aria-label":"Timers", h2 { "Timers" }
            if let Some(listing) = timers() {
                div { class: "timer-chatbar",
                    if chat_paused {
                        p { role: "status", "Timers in this chat are paused{pause_phrase(chat_pause, chat_local.as_deref())}." }
                        button { r#type: "button", disabled: busy(), onclick: move |_| write.call(("POST", resume_chat_path.clone(), pause_body(None), "Timers in this chat resumed.")), "Resume all" }
                    } else {
                        crate::timer_pause_view::PausePicker { label: "Pause all timers in this chat".to_owned(), disabled: busy(), onpick: move |ms| write.call(("POST", pause_chat_path.clone(), pause_body(Some(ms)), "Timers in this chat paused.")) }
                    }
                }
                if listing.rows.is_empty() { p { class: "field-help", "This chat has no timers yet." } }
                ul { class: "timer-list timer-cards",
                    for row in listing.rows.clone() {
                        crate::timer_card_view::TimerCard { key: "{row.detail.namespace}", row: row.clone(), chat_pause_ms: chat_pause, chat_pause_local: chat_local.clone(), now_ms: now_ms(), busy: busy(),
                            onpause: move |(namespace, until): (String, Option<i64>)| write.call(("POST", format!("/api/v2/timers/{namespace}/pause"), pause_body(until), if until.is_some() { "Timer paused." } else { "Timer resumed." })),
                            onedit: move |row: Listed| editor.set(Some(RuleForm::from_listed(&row))),
                            onadvanced: move |namespace: String| selected.set(namespace) }
                    }
                }
                if !listing.digests.is_empty() {
                    details { class: "timer-digests", summary { "Recent digests ({listing.digests.len()})" }
                        for digest in listing.digests.iter() {
                            article { key: "{digest.id}", class: "timer-digest",
                                p { class: "field-help", "{utc_time(digest.created_ms)} · {digest.item_count} quiet runs · " if digest.delivered_ms.is_some() { "sent" } else { "waiting to be sent" } }
                                pre { "{digest.text}" }
                            }
                        }
                    }
                }
            } else {
                p { class: "field-help", if list_notice().is_empty() { "Loading timers…" } else { "{list_notice}" } }
            }
            if !list_notice().is_empty() && timers().is_some() { p { class: "field-help", role: "status", "{list_notice}" } }
            if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
            if let Some(initial) = editor() {
                crate::timer_editor_view::TimerEditor { key: "{initial.editing.as_ref().map_or(String::new(), |e| e.namespace.clone())}", conversation: conversation.clone(), csrf: csrf.clone(), initial, session_scope, onexpired,
                    ondone: move |saved: bool| { editor.set(None); if saved { status.set("Saved.".into()); reload += 1; } } }
            } else {
                button { r#type: "button", class: "timer-new", onclick: move |_| editor.set(Some(RuleForm::default())), "New timer" }
            }
            details { class: "timer-advanced", summary { "Advanced: turn a timer off, stop it, or re-enable it" }
                p { "Select a timer with Details above, or open a saved timer by its ID. These controls disable, stop or roll back the schedule and re-enable it with fresh instructions." }
                form { onsubmit:move |event| {event.prevent_default();if valid_namespace(&entered()) {selected.set(entered().to_ascii_lowercase());}},
                    label { r#for:"timer-id", "Saved timer ID" }
                    input { id:"timer-id", value:"{entered}", oninput:move |event|entered.set(event.value()), required:true }
                    button { disabled:!valid_namespace(&entered()), "Open timer" }
                }
                if !selected().is_empty() {
                    TimerPanel { key:"{selected()}-{conversation}-{session_scope.read().generation()}", namespace:selected(), conversation, csrf, session_scope, onexpired }
                }
            }
        }
    }
}

fn pause_phrase(until: Option<i64>, local: Option<&str>) -> String {
    match until {
        Some(ms) if ms >= orkestr_v2_ui::timer_rules::FOREVER_MS => " until you resume them".into(),
        Some(ms) => format!(
            " until {}",
            local.map_or_else(|| utc_time(ms), str::to_owned)
        ),
        None => String::new(),
    }
}
#[component]
fn TimerPanel(
    namespace: String,
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let detail = use_signal(|| None::<Detail>);
    let fresh = use_signal(|| false);
    let mut epoch = use_signal(|| 0u64);
    rsx! {
        div {key:"{epoch()}", TimerRead {namespace, detail, fresh, epoch, selected_epoch:epoch(),session_scope,onexpired} }
        crate::timer_detail_view::TimerDetail {detail,fresh,epoch,conversation,csrf,session_scope,onexpired}
        button {onclick:move |_|epoch+=1,"Refresh timer details"}
    }
}
#[component]
fn TimerRead(
    namespace: String,
    mut detail: Signal<Option<Detail>>,
    mut fresh: Signal<bool>,
    epoch: Signal<u64>,
    selected_epoch: u64,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    let path = format!("/api/v2/timers/{namespace}");
    let channel = use_hook(move || {
        fresh.set(false);
        let eval = document::eval(include_str!("execution_poll.js"));
        let _ = eval.send(json!({"path":path}));
        eval
    });
    let mut notice = use_signal(|| "Loading timer…");
    use_drop(move || {
        dropped.set(false);
        let _ = channel.send(json!({"stop":true}));
    });
    use_future(move || {
        let active = active.clone();
        let namespace = namespace.clone();
        async move {
            let mut channel = channel;
            while let Ok(message) = channel.recv::<Value>().await {
                if !active.get()
                    || !session_scope.read().is_current(owner)
                    || epoch() != selected_epoch
                {
                    let _ = channel.send(json!({"stop":true}));
                    return;
                }
                if message["kind"] == "tick" {
                    continue;
                }
                let code = message["status"].as_u64().unwrap_or(0);
                if code == 401 || code == 403 {
                    let _ = channel.send(json!({"stop":true}));
                    onexpired.call(());
                    return;
                }
                let parsed = if code == 200 {
                    serde_json::from_value::<Detail>(message["body"].clone()).ok()
                } else {
                    None
                };
                if let Some(next) = parsed.filter(|next| {
                    next.valid_for(&namespace)
                        && detail
                            .read()
                            .as_ref()
                            .is_none_or(|old| next.revision >= old.revision)
                }) {
                    detail.set(Some(next));
                    fresh.set(true);
                    notice.set("Timer details updated.");
                } else {
                    fresh.set(false);
                    notice.set(if code == 404 {
                        "Saved timer unavailable for this account."
                    } else {
                        "Timer details unavailable. Refresh or reconnect."
                    });
                }
            }
            if active.get() && session_scope.read().is_current(owner) && epoch() == selected_epoch {
                fresh.set(false);
                notice.set("Timer connection interrupted.");
            }
        }
    });
    rsx! {p {role:"status","{notice}"}}
}
