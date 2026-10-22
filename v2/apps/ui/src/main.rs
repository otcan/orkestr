mod about;
mod acceptance_button;
mod accepted_results_bridge;
mod accepted_results_view;
mod archived_history_view;
mod attachment_keys_view;
mod attachments_view;
mod beta_bridge;
mod beta_discovery;
mod beta_settings;
mod beta_window_view;
mod chat_settings_view;
mod composer;
mod composer_tools;
mod conversation_location;
mod conversation_posts_view;
mod conversation_sidebar;
mod conversation_status_poll;
mod execution_panel;
mod execution_poll;
mod fast_panel;
mod held_inputs_poll;
mod held_inputs_view;
mod history;
mod ai_usage_view;
mod host_dashboard;
mod host_metrics_chart;
mod host_metrics_fetch;
mod host_metrics_panel;
mod host_metrics_poll;
mod host_metrics_view;
mod host_overview;
mod intelligence_view;
mod live_map_view;
mod memory_export_guard;
mod memory_transport;
mod memory_view;
mod message_time_view;
mod new_whatsapp_chat;
mod outbox_driver;
mod outbox_view;
mod page_memory_bridge;
mod progress_view;
mod projects_view;
mod restricted_view;
mod rich_text_view;
mod scroll_pin;
mod steering_view;
mod stop_button;
mod timer_bridge;
mod timer_card_view;
mod timer_detail_view;
mod timer_editor_view;
mod timer_pause_view;
mod timer_screen;
mod transport;
mod v1_manage_view;
mod v1_thread_view;
mod v1_workers_view;
mod views;
mod work_view;
mod worker_tasks_panel;
mod worker_tasks_view;
mod workers_view;
mod workspace;
use dioxus::prelude::*;
use orkestr_v2_ui::{session_scope::SessionScope, Draft};
use serde_json::Value;
use std::collections::BTreeMap;

fn main() {
    dioxus::launch(App);
}

/// The view named by the URL fragment when the page loaded.
#[derive(Clone, Copy)]
pub struct InitialRoute(pub Signal<Option<orkestr_v2_ui::route::Route>>);

/// `(instance ref, thread ref)` of an old V1 deep link.
#[derive(Clone, PartialEq)]
pub struct V1Link(pub (String, String));
#[component]
fn App() -> Element {
    let mut csrf = use_signal(String::new);
    let mut global = use_signal(String::new);
    let mut current = use_signal(String::new);
    let mut requested_conversation = use_signal(|| None::<String>);
    // An old V1 deep link (instance, thread refs), opened once the workspace mounts.
    let mut v1_link = use_signal(|| None::<V1Link>);
    use_context_provider(move || v1_link);
    let mut drafts = use_signal(BTreeMap::<String, Draft>::new);
    use_context_provider(move || drafts);
    let mut session_scope = use_signal(SessionScope::default);
    let mut saved_inputs = use_signal(orkestr_v2_ui::beta_inputs::SavedInputs::default);
    use_context_provider(move || saved_inputs);
    let mut window_intent = use_signal(orkestr_v2_ui::beta_window::WindowIntents::default);
    use_context_provider(move || window_intent);
    // Unsent messages of this owner; sent in the background by `OutboxDriver`.
    let mut outbox = use_signal(orkestr_v2_ui::outbox::Outbox::default);
    use_context_provider(move || outbox);
    let mut task_drafts = use_signal(|| {
        orkestr_v2_ui::task_draft_lifetime::TaskDrafts::new(dioxus::dioxus_core::current_scope_id())
    });
    use_context_provider(move || task_drafts);
    // Owner-scoped high-water marks outlive keyed conversation and tab remounts.
    let mut execution = use_signal(orkestr_v2_ui::execution::Execution::default);
    let mut host_resources = use_signal(orkestr_v2_ui::host_resources::HostResources::default);
    let open_metrics = use_context_provider(|| host_metrics_panel::OpenHostMetrics(Signal::new(0)));
    // The view named by the URL at load; the workspace opens it once mounted.
    let mut initial_route = use_context_provider(|| InitialRoute(Signal::new(None)));
    let mut held_inputs = use_signal(orkestr_v2_ui::held_inputs::HeldInputs::default);
    // Tab-scoped reload recovery; writes start only after this owner's restore.
    let mut memory_key = use_signal(|| None::<String>);
    let mut restored = use_signal(|| false);
    let mut recover = move |global: String| {
        let key = orkestr_v2_ui::page_memory::key(&global);
        restored.set(false);
        memory_key.set(key.clone());
        let Some(key) = key else { return };
        spawn(async move {
            let raw = page_memory_bridge::load(&key).await;
            if memory_key.peek().as_deref() != Some(key.as_str()) {
                return;
            }
            if let Some(raw) = raw {
                orkestr_v2_ui::page_memory::restore(
                    &raw,
                    &mut drafts.write(),
                    &mut saved_inputs.write(),
                    &mut window_intent.write(),
                );
            }
            restored.set(true);
        });
    };
    use_effect(move || {
        let drafts = drafts.read();
        let saved = saved_inputs.read();
        let intents = window_intent.read();
        if let (Some(key), true) = (memory_key(), restored()) {
            page_memory_bridge::store(
                &key,
                orkestr_v2_ui::page_memory::encode(&drafts, &saved, &intents),
            );
        }
    });
    let mut notice = use_signal(|| "Sign in to your local server.".to_string());
    let mut refresh = use_signal(|| 0_u64);
    let mut resuming = use_signal(|| true);
    let mut logging_out = use_signal(|| false);
    use_future(move || async move {
        requested_conversation.set(conversation_location::read().await);
        initial_route
            .0
            .set(conversation_location::read_route().await);
        v1_link.set(conversation_location::read_v1_link().await.map(V1Link));
        match transport::request::<transport::BrowserSession>(
            "GET",
            "/api/v2/browser/session",
            Value::Null,
            "",
            "",
        )
        .await
        {
            Ok(session) => {
                execution.write().authorization_lost();
                saved_inputs.write().clear_owner();
                window_intent.write().clear_scope();
                outbox.write().clear_owner();
                host_resources.write().clear_owner();
                held_inputs.write().clear_owner();
                task_drafts.write().clear_owner();
                session_scope
                    .write()
                    .activate(&session.global_conversation_id, &mut drafts.write());
                task_drafts
                    .write()
                    .activate(session_scope.read().generation());
                recover(session.global_conversation_id.clone());
                global.set(String::new());
                current.set(String::new());
                csrf.set(session.csrf_token);
                notice.set("Signed in.".into());
            }
            Err(error) => {
                if error.status != 401 {
                    notice.set(error.message);
                }
            }
        }
        resuming.set(false);
    });
    let mut expired = move |_| {
        execution.write().authorization_lost();
        saved_inputs.write().clear_owner();
        window_intent.write().clear_scope();
        outbox.write().clear_owner();
        host_resources.write().clear_owner();
        held_inputs.write().clear_owner();
        task_drafts.write().clear_owner();
        session_scope.write().invalidate();
        memory_key.set(None);
        global.set(String::new());
        current.set(String::new());
        requested_conversation.set(None);
        conversation_location::replace(None);
        refresh += 1;
        csrf.set(String::new());
        notice.set("Session expired. Sign in again; unsent drafts remain in this page.".into());
    };
    rsx! {
        style { "{include_str!(\"style.css\")}" }
        style { "{include_str!(\"host_metrics.css\")}" }
        style { "{include_str!(\"ai_usage.css\")}" }
        main { class: "app-shell",
            header { class: "app-heading", h1 { "Orkestr" } span { "Rust workspace · beta" }
                if !csrf().is_empty() && !current().is_empty() {
                    host_metrics_panel::HostMetricsPanel { key: "{session_scope.read().generation()}", session_scope, onexpired: expired,
                        onopen: move |_| { let mut open = open_metrics.0; open += 1; } }
                }
            }
            if csrf().is_empty() || notice().contains("not confirmed") {
                p { class: "app-notice", role: "status", "{notice}" }
            }
            if resuming() {
                p { role: "status", "Checking browser session…" }
            } else if logging_out() && csrf().is_empty() {
                p { role: "status", "Finishing sign-out before another sign-in…" }
            } else if csrf().is_empty() {
                views::Auth { onlogin: move |session: transport::BrowserSession| {
                    if logging_out() { return; }
                    execution.write().authorization_lost();
                    saved_inputs.write().clear_owner();
                    window_intent.write().clear_scope();
        outbox.write().clear_owner();
                    host_resources.write().clear_owner();
                    held_inputs.write().clear_owner();
                    task_drafts.write().clear_owner();
                    session_scope.write().activate(&session.global_conversation_id, &mut drafts.write());
                    task_drafts.write().activate(session_scope.read().generation());
                    recover(session.global_conversation_id.clone());
                    refresh += 1;
                    global.set(String::new());
                    current.set(String::new());
                    csrf.set(session.csrf_token);
                    notice.set("Signed in.".into());
                } }
            } else if current().is_empty() {
                beta_discovery::BetaDiscoveryGate {
                    key: "{session_scope.read().generation()}-{refresh}", session_scope, conversation: requested_conversation(),
                    onexpired: expired,
                    onready: move |value: orkestr_v2_contracts::BetaDiscovery| {
                        global.set(value.conversation_id.to_string());
                        current.set(value.conversation_id.to_string());
                        conversation_location::replace(Some(&value.conversation_id.to_string()));
                    }
                }
                if requested_conversation().is_some() { button { onclick: move |_| { requested_conversation.set(None); refresh += 1; conversation_location::replace(None); }, "Open default conversation" } }
            } else {
                workspace::Workspace { key: "{session_scope.read().generation()}-{refresh}", current, csrf: csrf(), session_scope, execution, drafts, held_inputs, onexpired: expired }
            }
            if !csrf().is_empty() { outbox_view::ReplyGestures {} }
            if !csrf().is_empty() && !current().is_empty() && !global().is_empty() {
                outbox_driver::OutboxDriver { key: "outbox-{session_scope.read().generation()}-{global}", global: global(), csrf: csrf(), session_scope, onexpired: expired }
            }
            if !csrf().is_empty() {
                    attachment_keys_view::AttachmentKeyEnrollment { key: "keys-{session_scope.read().generation()}", csrf: csrf() }
                    button { class: "sign-out", disabled: logging_out(), onclick: move |_| {
                        if logging_out() { return; }
                        logging_out.set(true);
                        let secret = csrf();
                        let generation = session_scope.read().generation();
                        spawn(async move {
                            let result = transport::request::<Value>("DELETE", "/api/v2/browser/session", Value::Null, &secret, "").await;
                            if !session_scope.read().is_current(generation) { logging_out.set(false); return; }
                            match result {
                                Ok(_) => {
                                    execution.write().authorization_lost();
                                    saved_inputs.write().clear_owner();
                                    window_intent.write().clear_scope();
        outbox.write().clear_owner();
                                    host_resources.write().clear_owner();
                                    held_inputs.write().clear_owner();
                                    task_drafts.write().clear_owner();
                                    session_scope.write().invalidate();
                                    if let Some(key) = memory_key.take() { page_memory_bridge::store(&key, None); }
                                    global.set(String::new()); current.set(String::new()); refresh += 1;
                                    requested_conversation.set(None); conversation_location::replace(None);
                                    csrf.set(String::new());
                                    notice.set("Signed out. Server session revoked; unsent drafts remain in this page.".into());
                                }
                                Err(error) if error.status == 401 => expired(()),
                                Err(error) => notice.set(format!("Sign-out not confirmed. {}", error.message)),
                            }
                            logging_out.set(false);
                        });
                    }, if logging_out() { "Signing out…" } else { "Sign out" } }
            }
        }
    }
}
