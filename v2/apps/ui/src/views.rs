use crate::transport;
use dioxus::prelude::*;
use orkestr_v2_contracts::Credentials;
use orkestr_v2_ui::{session_scope::SessionScope, Draft, Projection};
use serde_json::Value;
use std::collections::BTreeMap;

#[component]
pub fn Auth(onlogin: EventHandler<transport::BrowserSession>) -> Element {
    let mut username = use_signal(String::new);
    let mut password = use_signal(String::new);
    let mut bootstrap = use_signal(String::new);
    let mut setup = use_signal(|| false);
    // Desktop first run: the app handed over the setup token (no terminal).
    let mut local = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut status = use_signal(String::new);
    use_future(move || async move {
        if let Some(token) = crate::local_setup::take().await {
            bootstrap.set(token);
            setup.set(true);
            local.set(true);
        }
    });
    rsx! {
        form { onsubmit: move |event| {
            event.prevent_default();
            if busy() { return; }
            busy.set(true);
            spawn(async move {
                let credentials = Credentials { username: username(), password: password() };
                password.set(String::new());
                let secret = bootstrap();
                // A handed-over token stays for a retry; a typed one is cleared.
                if !local() { bootstrap.set(String::new()); }
                let body = serde_json::to_value(credentials).unwrap_or(Value::Null);
                let result = if setup() {
                    match transport::request::<Value>("POST", "/api/v2/setup", body.clone(), "", &secret).await {
                        // This computer already has its owner: sign in instead.
                        Err(error) if local() && error.status == 409 => { setup.set(false); Ok(()) }
                        result => result.map(|_| ()),
                    }
                } else { Ok(()) };
                match result {
                    Err(error) => status.set(error.message),
                    Ok(()) => match transport::request("POST", "/api/v2/browser/session", body, "", "").await {
                        Ok(session) => onlogin.call(session),
                        Err(error) => status.set(error.message),
                    }
                }
                busy.set(false);
            });
        },
            h2 { if setup() && local() { "Create your account" } else if setup() { "Create owner account" } else { "Sign in" } }
            if setup() && local() {
                p { "This account stays on this computer. Choose a username and a password of at least 12 characters." }
            } else {
                p { "Sign in to your local assistant." }
            }
            label { r#for: "username", "Username" }
            input { id: "username", autocomplete: "username", required: true, value: "{username}", oninput: move |e| username.set(e.value()) }
            label { r#for: "password", "Password" }
            input { id: "password", r#type: "password", autocomplete: if setup() { "new-password" } else { "current-password" }, required: true, value: "{password}", oninput: move |e| password.set(e.value()) }
            if setup() && !local() {
                label { r#for: "bootstrap", "Local operator bootstrap token" }
                input { id: "bootstrap", r#type: "password", autocomplete: "off", required: true, value: "{bootstrap}", oninput: move |e| bootstrap.set(e.value()) }
                p { "Use the setup token provided by your operator. Keep it private. Setup creates the first owner account once." }
            }
            button { r#type: "submit", disabled: busy(), if busy() { "Connecting…" } else { "Continue" } }
            button { r#type: "button", disabled: busy(), onclick: move |_| setup.set(!setup()), if setup() { "Use existing owner account" } else { "First-time setup" } }
            p { role: "status", "{status}" }
        }
    }
}

#[component]
pub fn Conversation(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut projection = use_signal(Projection::default);
    let mut status = use_signal(|| "Loading history…".to_string());
    let mut accepted_revision = use_signal(|| 0_i64);
    // Default auto-accept (V1): no Accept prompt unless the owner asked to review.
    let mut auto_accept = use_signal(|| false);
    let settings_path = format!("/api/v2/conversations/{id}/settings");
    use_resource(move || {
        let path = settings_path.clone();
        async move {
            let result = transport::request::<orkestr_v2_contracts::ConversationSettings>(
                "GET",
                &path,
                Value::Null,
                "",
                "",
            )
            .await;
            if session_scope.read().is_current(generation) {
                auto_accept.set(orkestr_v2_ui::chat_settings::auto_accepts(
                    result.ok().as_ref(),
                ));
            }
        }
    });
    let mut connection = use_signal(orkestr_v2_ui::live_stream::Connection::default);
    let stream_id = id.clone();
    let stream_csrf = csrf.clone();
    use_future(move || {
        let id = stream_id.clone();
        let csrf = stream_csrf.clone();
        async move {
            use orkestr_v2_ui::live_stream::{backoff_ms, classify, Connection, Next};
            let mut cursor = 0;
            let mut resync = true;
            // Re-read history after the cursor before the next stream read.
            let mut catch_up = false;
            // Each applied snapshot may skip journal events between the old
            // cursor and the new watermark (an accepted reply among them), so
            // every advance asks the chat to read replies after its newest.
            let mut advanced = move |watermark: i64, previous: i64| {
                if watermark > previous {
                    let revision = *accepted_revision.peek();
                    accepted_revision.set(revision + 1);
                }
            };
            loop {
                if !session_scope.read().is_current(generation) {
                    projection.set(Projection::default());
                    return;
                }
                let mut failed: Option<String> = None;
                if resync || catch_up {
                    let (after, base) = if resync {
                        (0, Projection::default())
                    } else {
                        (cursor, projection.peek().clone())
                    };
                    let result = transport::snapshot(&id, &csrf, after, base, after).await;
                    if !session_scope.read().is_current(generation) {
                        projection.set(Projection::default());
                        return;
                    }
                    match result {
                        Ok(snapshot) => {
                            let previous = cursor;
                            cursor = snapshot.watermark;
                            if resync || snapshot.watermark != previous {
                                projection.set(snapshot);
                            }
                            // The first load already reads every reply.
                            if !(resync && previous == 0) {
                                advanced(cursor, previous);
                            }
                            if resync {
                                status.set("History synchronized.".into());
                            }
                            resync = false;
                            catch_up = false;
                            connection.set(Connection::Live);
                        }
                        Err(error) if error.status == 401 => {
                            onexpired.call(());
                            return;
                        }
                        Err(error) => failed = Some(error.message),
                    }
                }
                if failed.is_none() {
                    let result = transport::event(&id, cursor).await;
                    if !session_scope.read().is_current(generation) {
                        projection.set(Projection::default());
                        return;
                    }
                    match result {
                        Err(error) => failed = Some(error.message),
                        Ok(item) => match classify(&item) {
                            Next::Expired => {
                                onexpired.call(());
                                return;
                            }
                            Next::Resync => {
                                resync = true;
                                status.set("Reloading history…".into());
                                transport::sleep(250).await;
                                continue;
                            }
                            Next::CatchUp => {
                                catch_up = true;
                                continue;
                            }
                            Next::Failure => {
                                failed = Some(if item.status >= 400 {
                                    format!("Connection lost (HTTP {}). Reconnecting…", item.status)
                                } else {
                                    "Connection lost. Reconnecting…".into()
                                })
                            }
                            Next::Apply => {
                                connection.set(Connection::Live);
                                let previous = projection.read().clone();
                                let sequence = item.body.as_ref().and_then(|event| {
                                    orkestr_v2_ui::replay_sequence(
                                        &previous,
                                        &item.event,
                                        item.id.as_deref(),
                                        event,
                                    )
                                    .ok()
                                });
                                match sequence {
                                    None => {
                                        resync = true;
                                        status
                                            .set("History changed unexpectedly. Reloading…".into());
                                    }
                                    Some(sequence) if sequence > cursor => {
                                        let result = transport::snapshot(
                                            &id, &csrf, cursor, previous, sequence,
                                        )
                                        .await;
                                        if !session_scope.read().is_current(generation) {
                                            projection.set(Projection::default());
                                            return;
                                        }
                                        match result {
                                            Ok(snapshot) if snapshot.watermark >= sequence => {
                                                let before = cursor;
                                                cursor = snapshot.watermark;
                                                projection.set(snapshot);
                                                if let Some(event) = item.body.as_ref() {
                                                    execution.write().acceptances.observe(event);
                                                    status.set(
                                                        orkestr_v2_ui::replay_notice(event).into(),
                                                    );
                                                }
                                                advanced(cursor, before);
                                            }
                                            Ok(_) => {
                                                resync = true;
                                                status.set("Snapshot has not reached journal event; resync required.".into());
                                            }
                                            Err(error) if error.status == 401 => {
                                                onexpired.call(());
                                                return;
                                            }
                                            Err(error) => failed = Some(error.message),
                                        }
                                    }
                                    Some(_) => {}
                                }
                            }
                        },
                    }
                }
                if let Some(message) = failed {
                    // Back off, then catch up from the last applied cursor.
                    let next = connection.peek().failed();
                    connection.set(next);
                    status.set(message);
                    catch_up = !resync;
                    transport::wait_for_wake(backoff_ms(next.failures())).await;
                }
            }
        }
    });
    // Details drawer: closed by default, remembered per viewer.
    let mut details_open = use_signal(|| false);
    use_future(move || async move {
        if let Some(open) =
            transport::stored_flag(orkestr_v2_ui::live_stream::DETAILS_OPEN_KEY).await
        {
            details_open.set(open);
        }
    });
    let now = use_signal(|| 0_u64);
    let posts = crate::conversation_posts_view::use_conversation_posts(id.clone(), session_scope);
    let messages = projection
        .read()
        .messages
        .values()
        .map(orkestr_v2_ui::chat_timeline::Input::from)
        .collect::<Vec<_>>();
    let live_status = execution
        .read()
        .control_status()
        .filter(|s| s.conversation_id.to_string() == id);
    let failure = live_status
        .as_ref()
        .and_then(orkestr_v2_ui::execution::failure_notice);
    rsx! {
        section { class: "conversation-pane", "aria-label": "Conversation",
            crate::execution_poll::ExecutionPoll { key: "{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, execution, worker_tasks: false, headless: true, clock: Some(now), onexpired }
            div { class: "conversation-toolbar",
                button { r#type: "button", class: "details-toggle", "aria-expanded": "{details_open}", "aria-controls": "conversation-details-{id}",
                    onclick: move |_| {
                        let open = !details_open();
                        details_open.set(open);
                        transport::store_flag(orkestr_v2_ui::live_stream::DETAILS_OPEN_KEY, open);
                    },
                    "Details"
                }
            }
            div { class: "conversation-scroll", tabindex: "0", "aria-label": "Conversation transcript",
                crate::archived_history_view::ArchivedHistory { key: "archived-{id}-{generation}", id: id.clone(), session_scope, onexpired }
                crate::intelligence_view::IntelligencePanel { key:"intelligence-{id}-{generation}", id:id.clone(), csrf:csrf.clone(), session_scope, execution, onexpired, onaccepted:move |_revision| { let next = *accepted_revision.peek() + 1; accepted_revision.set(next); }, auto_accept: auto_accept() }
                crate::accepted_results_view::AcceptedReplies { key: "accepted-{id}-{generation}", id: id.clone(), session_scope, messages, posts: posts(), update: Some(accepted_revision), inline: true, onexpired }
                if let Some(current) = live_status.filter(|s| s.progress.is_some() && s.phase != orkestr_v2_contracts::ExecutionPhase::Completed) {
                    div { key: "{current.conversation_id}/{current.progress.as_ref().unwrap().payload_id}", class: "chat-messages live-answer-row",
                        crate::progress_view::ProgressView { status: current, csrf: csrf.clone(), execution, session_scope, onexpired, plain: true }
                    }
                }
                if let Some(notice) = failure {
                    article { class: "assistant-proposal run-failed", role: "alert",
                        h3 { "Reply failed" }
                        p { "{notice}" }
                    }
                }
            }
            if let Some(text) = connection().bar() {
                div { class: "connection-bar", role: "status",
                    span { "{text}" }
                    button { r#type: "button", onclick: move |_| transport::retry_stream(), "Retry" }
                }
            }
            aside { class: "conversation-details", id: "conversation-details-{id}", hidden: !details_open(), "aria-label": "Conversation details",
                section { class: "conversation-tools", "aria-label": "Files and held inputs",
                    h3 { "Files and held inputs" }
                    crate::attachments_view::ThreadFiles { key: "files-{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, onexpired }
                    crate::held_inputs_poll::HeldInputsPanel { key: "held-{id}-{generation}", id: id.clone(), session_scope, model: held_inputs, projection, onexpired }
                }
                section { class: "conversation-tools", "aria-label": "Connection and work details",
                    h3 { "Connection and work details" }
                    crate::beta_window_view::WindowView { key: "window-{id}-{generation}", id:id.clone(), session_scope, onexpired }
                    p { class: "stream-status", "{status}" }
                    p { "Latest 100 saved inputs. History has earlier pages. Unsent drafts remain in this page." }
                }
            }
            crate::scroll_pin::ScrollPin {}
            div { class: "composer-dock",
                crate::execution_panel::ExecutionPanel { execution, now_ms: now(), parent_tasks: false, csrf: csrf.clone(), session_scope, onexpired, compact: true, auto_accept: auto_accept(), onaccepted: Some(EventHandler::new(move |_revision| { let next = *accepted_revision.peek() + 1; accepted_revision.set(next); })) }
                crate::composer::Composer { key: "composer-{id}-{generation}", id: id.clone(), csrf: csrf.clone(), session_scope, drafts, onexpired }
            }
        }
    }
}
