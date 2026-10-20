use dioxus::prelude::*;
use orkestr_v2_contracts::{LiveConversation, LiveMap, LiveRole};
use orkestr_v2_ui::{
    live_map::{
        ago, conversation_active, host_status, kind_label, phase_label, run_label, short_id,
        unlinked_conversations, views, window_label, worker_running, SessionRow, ViewRow,
        REFRESH_MS,
    },
    session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Read {
    status: u16,
    text: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Notice {
    Loading,
    Unconfigured,
    Unavailable,
}

fn start() -> document::Eval {
    let source = include_str!("live_map_request.mjs")
        .replace("export const", "const")
        .replace("export async function", "async function");
    let script = format!("{source}\nawait dioxus.recv();const c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await liveMapRequest({{signal:c.signal}});}}finally{{done=true;c.abort();}}");
    let eval = document::eval(&script);
    let _ = eval.send(json!({}));
    eval
}

/// Owner-wide map of views, attached sessions, agents and native Workers.
/// Reading only; refreshes every ten seconds while mounted.
#[component]
pub fn LiveMapView(session_scope: Signal<SessionScope>, onexpired: EventHandler<()>) -> Element {
    let owner = session_scope.read().generation();
    let mut map = use_signal(|| None::<LiveMap>);
    let mut notice = use_signal(|| Notice::Loading);
    let mut active_only = use_signal(|| true);
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    use_future(move || async move {
        loop {
            let eval = start();
            channel.set(Some(eval));
            let reply = eval.join::<Read>().await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            channel.set(None);
            match reply {
                Ok(Read { status: 200, text }) => {
                    match serde_json::from_str::<LiveMap>(&text)
                        .ok()
                        .filter(LiveMap::is_valid)
                    {
                        Some(value) => map.set(Some(value)),
                        None => notice.set(Notice::Unavailable),
                    }
                }
                Ok(Read {
                    status: 401 | 403, ..
                }) => {
                    onexpired.call(());
                    return;
                }
                Ok(Read { status: 404, .. }) => {
                    map.set(None);
                    notice.set(Notice::Unconfigured);
                }
                _ => notice.set(Notice::Unavailable),
            }
            let wait = format!("await new Promise(r=>setTimeout(r,{REFRESH_MS}));return null;");
            let _ = document::eval(&wait).await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
        }
    });
    let current = map.read();
    rsx! {
        section { class: "live-map", "aria-label": "Live map",
            header { class: "live-map-heading",
                h2 { "Live map" }
                div { class: "live-filter", role: "group", "aria-label": "Show",
                    button { r#type: "button", "aria-pressed": "{active_only()}", onclick: move |_| active_only.set(true), "Active only" }
                    button { r#type: "button", "aria-pressed": "{!active_only()}", onclick: move |_| active_only.set(false), "All" }
                }
            }
            p { class: "live-map-note", "Which views map to which threads and conversations, the sessions attached to them, and the agents and Workers they run. Refreshes every 10 seconds; reading never starts or stops work." }
            if let Some(value) = current.as_ref() {
                p { role: "status", class: "live-map-status",
                    "{host_status(value)} · updated {ago(value.observed_at_ms, Some(value.observed_at_ms))}"
                    if notice() == Notice::Unavailable { " · last refresh failed, retrying" }
                }
                {render(value, active_only())}
            } else {
                p { role: "status", class: "live-map-status",
                    match notice() {
                        Notice::Loading => "Loading live map…",
                        Notice::Unconfigured => "Live map is not configured on this server.",
                        Notice::Unavailable => "Live map unavailable. Retrying…",
                    }
                }
            }
        }
    }
}

fn render(map: &LiveMap, active_only: bool) -> Element {
    let rows = views(map, active_only);
    let others = unlinked_conversations(map, active_only);
    let now = map.observed_at_ms;
    let total = map.host.views.len();
    rsx! {
        h3 { "Views ({rows.len()} of {total})" }
        if rows.is_empty() {
            p { class: "live-empty", if active_only { "No view has live activity right now." } else { "No views reported." } }
        }
        ul { class: "live-tree",
            for row in rows.iter() {
                {view_node(row, now)}
            }
        }
        h3 { "V2 conversations" }
        if others.is_empty() {
            p { class: "live-empty", if active_only { "No other V2 conversation is active." } else { "No other V2 conversations." } }
        }
        ul { class: "live-tree",
            for conversation in others.iter() {
                li { class: "live-node live-conversation", key: "{conversation.conversation_id}",
                    {conversation_node(conversation, now)}
                }
            }
        }
        if map.conversations_truncated {
            p { class: "live-empty", "Only the first {map.conversations.len()} V2 conversations are shown." }
        }
    }
}

fn badge(class: &'static str, text: &str) -> Element {
    rsx! { span { class: "live-badge {class}", "{text}" } }
}

fn view_node(row: &ViewRow<'_>, now: i64) -> Element {
    let view = row.view;
    let name = view.name.clone().unwrap_or_else(|| "Unnamed view".into());
    let kind = if view.view == "whatsapp-group" {
        "WhatsApp group"
    } else {
        view.view.as_str()
    };
    let active = row.sessions.iter().any(|s| s.session.live)
        || row.conversation.is_some_and(conversation_active);
    let delegated = view.delegated_to_v2.as_ref();
    rsx! {
        li { class: "live-node live-view", key: "{view.thread_id.clone().unwrap_or_default()}-{name}",
            details { open: active,
                summary {
                    span { class: "live-title", "{name}" }
                    {badge("live-kind", kind)}
                    if delegated.is_some() { {badge("live-v2", "Delegated to V2")} }
                    if active { {badge("live-on", "live")} }
                }
                ul { class: "live-tree",
                    li { class: "live-node live-thread",
                        span { class: "live-label", "Thread" }
                        span { class: "live-id", title: "{view.thread_id.clone().unwrap_or_default()}", "{short_id(view.thread_id.as_deref().unwrap_or(\"none\"))}" }
                        if let Some(fast) = &view.fast_layer {
                            span { class: "live-meta", "Fast layer: {fast}" }
                        }
                    }
                    if let Some(delegation) = delegated {
                        li { class: "live-node live-conversation",
                            if let Some(conversation) = row.conversation {
                                {conversation_node(conversation, now)}
                            } else {
                                span { class: "live-label", "V2" }
                                span { class: "live-meta",
                                    "{delegation.remote_backend.clone().unwrap_or_else(|| \"remote\".into())} thread "
                                    "{short_id(delegation.remote_thread_id.as_deref().unwrap_or(\"unknown\"))}"
                                    if delegation.remote_runtime_enabled == Some(false) { " · runtime off" }
                                }
                            }
                        }
                    }
                    for session in row.sessions.iter() {
                        {session_node(session, now)}
                    }
                    if row.hidden_sessions > 0 {
                        li { class: "live-node live-hidden", "{row.hidden_sessions} idle sessions hidden" }
                    }
                    if view.sessions.is_empty() {
                        li { class: "live-node live-hidden", "No sessions attached" }
                    }
                }
            }
        }
    }
}

fn session_node(row: &SessionRow<'_>, now: i64) -> Element {
    let session = row.session;
    let running = row.agents.iter().filter(|a| a.status == "running").count();
    rsx! {
        li { class: "live-node live-session", key: "{session.session_id}",
            div { class: "live-line",
                span { class: "live-label", "{session.role}" }
                span { class: "live-title", "{kind_label(&session.kind)}" }
                span { class: "live-id", title: "{session.session_id}", "{short_id(&session.session_id)}" }
                if session.live { {badge("live-on", "live")} } else { {badge("live-off", "idle")} }
                span { class: "live-meta", "last {ago(now, session.last_activity_ms)}" }
                if running > 0 { span { class: "live-meta", "{running} running" } }
            }
            if !row.agents.is_empty() || row.hidden_agents > 0 {
                ul { class: "live-tree",
                    for agent in row.agents.iter() {
                        li { class: "live-node live-agent", key: "{agent.agent_id}",
                            div { class: "live-line",
                                span { class: "live-label", "Agent" }
                                span { class: "live-title", "{agent.name.clone().unwrap_or_else(|| agent.agent_id.clone())}" }
                                if agent.status == "running" { {badge("live-on", "running")} } else { {badge("live-off", &agent.status)} }
                                span { class: "live-meta", "last {ago(now, agent.last_activity_ms)}" }
                            }
                        }
                    }
                    if row.hidden_agents > 0 {
                        li { class: "live-node live-hidden", "{row.hidden_agents} finished or idle agents hidden" }
                    }
                }
            }
        }
    }
}

fn role(name: &'static str, value: Option<&LiveRole>) -> Element {
    rsx! {
        span { class: "live-role",
            "{name}: "
            match value {
                Some(role) if orkestr_v2_ui::live_map::role_active(role) => rsx! { {badge("live-on", phase_label(role.phase))} },
                Some(role) => rsx! { {badge("live-off", phase_label(role.phase))} },
                None => rsx! { {badge("live-off", "none")} },
            }
        }
    }
}

fn conversation_node(conversation: &LiveConversation, now: i64) -> Element {
    let window = conversation.window.as_ref();
    rsx! {
        div { class: "live-line",
            span { class: "live-label", "V2 conversation" }
            span { class: "live-title", "{conversation.name}" }
            if conversation_active(conversation) { {badge("live-on", "live")} } else { {badge("live-off", "idle")} }
            if conversation.partial { {badge("live-warn", "partly unknown")} }
        }
        div { class: "live-line live-roles",
            span { class: "live-role",
                "Window: "
                if let Some(w) = window {
                    {badge(if matches!(w.state, orkestr_v2_contracts::ExecutionWindowState::Closed) { "live-off" } else { "live-on" }, window_label(w.state))}
                    span { class: "live-meta", " #{w.generation} · opened {ago(now, Some(w.opened_at_ms))}" }
                } else {
                    {badge("live-off", "none")}
                }
            }
            {role("Fast", conversation.fast.as_ref())}
            {role("Deep", conversation.deep.as_ref())}
        }
        if !conversation.workers.is_empty() {
            ul { class: "live-tree",
                for worker in conversation.workers.iter() {
                    li { class: "live-node live-agent", key: "{worker.run_id}",
                        div { class: "live-line",
                            span { class: "live-label", "Worker" }
                            span { class: "live-id", title: "{worker.run_id}", "{short_id(&worker.run_id.to_string())}" }
                            if worker_running(worker) { {badge("live-on", run_label(worker.state))} } else { {badge("live-off", run_label(worker.state))} }
                        }
                    }
                }
            }
        }
    }
}
