use dioxus::prelude::*;
use orkestr_v2_contracts::HostMetricsRange;
use orkestr_v2_contracts::{SidebarEntry, V1LinkTarget};
use orkestr_v2_ui::{
    route::{Route, Tab},
    session_scope::SessionScope,
    Draft,
};
use std::collections::BTreeMap;

/// Navigation changes presentation only. Work admission remains an explicit action.
#[component]
pub fn Workspace(
    mut current: Signal<String>,
    csrf: String,
    session_scope: Signal<SessionScope>,
    mut execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    // The heading's host metrics panel opens the details tab.
    let open_metrics = use_context::<crate::host_metrics_panel::OpenHostMetrics>().0;
    let mut seen_metrics = use_signal(|| *open_metrics.peek());
    let initial = use_context::<crate::InitialRoute>().0.peek().clone();
    let mut title = use_signal(|| "Assistant".to_string());
    let mut tab = use_signal(|| match &initial {
        Some(Route::Conversation { tab, .. }) => *tab,
        Some(Route::Host { .. }) => Tab::Host,
        _ => Tab::Chat,
    });
    let mut host_charts = use_signal(|| matches!(initial, Some(Route::Host { charts: true, .. })));
    let mut host_range = use_signal(|| match &initial {
        Some(Route::Host { range, .. }) => *range,
        _ => HostMetricsRange::Hour1,
    });
    // Sidebar rows of the last poll, to open a V1 chat named by the URL at once.
    let mut rows_seen = use_signal(Vec::<SidebarEntry>::new);
    let mut sidebar = use_signal(|| false);
    let mut reload = use_signal(|| 0_u64);
    // A linked V1 chat is shown read-only instead of a native conversation.
    let mut linked = use_signal(|| None::<SidebarEntry>);
    let mut live = use_signal(|| None::<SidebarEntry>);
    // An old V1 deep link: a migrated thread opens its conversation, a V1 one
    // its linked entry once the sidebar lists it.
    let mut v1_link = use_context::<Signal<Option<crate::V1Link>>>();
    use_effect(move || {
        let requested = open_metrics();
        if requested != *seen_metrics.peek() {
            seen_metrics.set(requested);
            linked.set(None);
            execution.write().select(&current.peek(), "");
            host_charts.set(false);
            tab.set(Tab::Host);
        }
    });
    let mut wanted = use_signal(|| match &initial {
        Some(Route::V1Thread { thread }) => Some(thread.clone()),
        _ => None,
    });
    // The URL follows the view: each change the owner makes is a history entry.
    let mut shown = use_signal(|| None::<Route>);
    use_effect(move || {
        let route = match linked() {
            Some(entry) => match entry.v1_thread_id {
                Some(thread) => Route::V1Thread { thread },
                None => return,
            },
            None if tab() == Tab::Host => Route::Host {
                charts: host_charts(),
                range: host_range(),
            },
            None if current().is_empty() => return,
            None => Route::Conversation {
                id: current(),
                tab: tab(),
            },
        };
        if wanted.peek().is_some() {
            return; // a V1 chat named by the URL is still being opened
        }
        if shown.peek().as_ref() != Some(&route) {
            if shown.peek().is_some() {
                crate::conversation_location::push(&route);
            }
            shown.set(Some(route));
        }
    });
    // Back and forward restore the view the fragment names.
    use_future(move || async move {
        loop {
            let Some(hash) = crate::conversation_location::next_navigation().await else {
                return;
            };
            let Some(route) = Route::parse(&hash) else {
                continue;
            };
            shown.set(Some(route.clone()));
            match route {
                Route::Conversation {
                    id,
                    tab: wanted_tab,
                } => {
                    linked.set(None);
                    if *current.peek() != id {
                        execution.write().select(&id, "");
                        current.set(id);
                        reload += 1;
                    }
                    tab.set(wanted_tab);
                }
                Route::Host { charts, range } => {
                    linked.set(None);
                    host_charts.set(charts);
                    host_range.set(range);
                    tab.set(Tab::Host);
                }
                Route::V1Thread { thread } => {
                    match rows_seen
                        .peek()
                        .iter()
                        .find(|row| row.key == format!("v1:{thread}"))
                    {
                        Some(row) => {
                            tab.set(Tab::Chat);
                            linked.set(Some(row.clone()));
                        }
                        None => wanted.set(Some(thread)),
                    }
                }
            }
        }
    });
    let mut link_notice = use_signal(String::new);
    use_future(move || async move {
        let Some(crate::V1Link((instance, thread))) = v1_link.peek().clone() else {
            return;
        };
        v1_link.set(None);
        let path = format!("/api/v2/v1-links/{thread}?instance={instance}");
        let owner = session_scope.peek().generation();
        let result = crate::transport::request::<V1LinkTarget>(
            "GET",
            &path,
            serde_json::Value::Null,
            "",
            "",
        )
        .await;
        if !session_scope.peek().is_current(owner) {
            return;
        }
        match result {
            Ok(target) if target.is_valid() => match target {
                V1LinkTarget::Conversation { conversation_id } => {
                    let id = conversation_id.to_string();
                    linked.set(None);
                    execution.write().select(&id, "");
                    current.set(id);
                    reload += 1;
                }
                V1LinkTarget::V1Thread { thread_id } => wanted.set(Some(thread_id)),
            },
            Err(error) if error.status == 401 => {
                onexpired.call(());
                return;
            }
            _ => link_notice.set(
                "This V1 link does not open here: the chat is retired, unknown or not yours."
                    .into(),
            ),
        }
        crate::conversation_location::replace(Some(&current.peek()));
    });
    let selected = match linked() {
        Some(entry) => entry.key,
        None => format!("v2:{}", current()),
    };
    let header = live();
    let activity = header
        .as_ref()
        .and_then(|e| orkestr_v2_ui::sidebar::activity_label(&e.activity));
    rsx! {
        div { class: "workspace", "data-sidebar-open": "{sidebar}",
            crate::conversation_sidebar::ConversationSidebar {
                selected: selected.clone(), csrf: csrf.clone(), session_scope, onexpired,
                onloaded: move |rows: Vec<SidebarEntry>| {
                    rows_seen.set(rows.clone());
                    let pending = wanted.peek().clone();
                    if let Some(thread) = pending {
                        wanted.set(None);
                        if let Some(row) = rows.iter().find(|row| row.key == format!("v1:{thread}")) {
                            tab.set(Tab::Chat);
                            linked.set(Some(row.clone()));
                        }
                    }
                    let key = match linked.peek().as_ref() { Some(entry) => entry.key.clone(), None => format!("v2:{}", current.peek()) };
                    let row = rows.into_iter().find(|row| row.key == key);
                    if let Some(row) = &row { title.set(row.name.clone()); }
                    live.set(row);
                },
                onselect: move |row: SidebarEntry| {
                    sidebar.set(false);
                    tab.set(Tab::Chat);
                    title.set(row.name.clone());
                    live.set(Some(row.clone()));
                    if row.read_only {
                        linked.set(Some(row));
                        return;
                    }
                    let Some(id) = row.conversation_id.as_ref().map(ToString::to_string) else { return };
                    linked.set(None);
                    // Fence a late control response before the new keyed reader mounts.
                    execution.write().select(&id, "");
                    current.set(id);
                    reload += 1;
                }
            }
            if sidebar() { button { class: "drawer-scrim", r#type: "button", "aria-label": "Close conversations", onclick: move |_| sidebar.set(false) } }
            div { class: "workspace-main",
                if !link_notice().is_empty() { p { class: "app-notice link-notice", role: "status", "{link_notice}" } }
                header { class: "conversation-heading",
                    button { class: "threads-toggle", "aria-expanded": "{sidebar}", "aria-label": "Conversations", onclick: move |_| sidebar.set(!sidebar()), span { "aria-hidden": "true", "☰" } }
                    if let Some(entry) = header.as_ref() {
                        crate::conversation_sidebar::Avatar { key: "{entry.key}", name: entry.name.clone(), thread: entry.v1_thread_id.clone() }
                    }
                    div { class: "heading-title",
                        h2 { "{title}" }
                        if let Some(label) = activity.clone() {
                            p { class: "heading-activity", role: "status", "{label}" }
                        } else if let Some(entry) = header.as_ref().filter(|e| e.read_only) {
                            p { class: "heading-meta", if entry.coordinator { "On V1 · coordinator attached" } else { "On V1 · read-only" } }
                        }
                    }
                    if linked().is_none() { nav { "aria-label": "Main",
                        for name in Tab::ALL {
                            button { "aria-current": if tab() == name { "page" } else { "false" }, onclick: move |_| {
                                if tab() == name { return; }
                                execution.write().select(&current(), "");
                                if name == Tab::Host { host_charts.set(false); }
                                tab.set(name);
                            }, "{name.label()}" }
                        }
                    } }
                }
                if let Some(entry) = linked() {
                    crate::v1_thread_view::V1ThreadView { key: "{entry.key}-{session_scope.read().generation()}", entry, csrf: csrf.clone(), session_scope, drafts, onexpired }
                } else if tab() == Tab::Chat {
                    SelectedConversation {
                        key: "{current()}-{session_scope.read().generation()}-{reload}",
                        id: current(), csrf, session_scope, execution, drafts, held_inputs, onexpired
                    }
                } else {
                    div { class: "workspace-page",
                        if tab() == Tab::Work {
                            crate::work_view::WorkView { key: "{current()}-{session_scope.read().generation()}", id: current(), csrf, session_scope, execution, onexpired }
                        } else if tab() == Tab::History {
                            crate::history::History { key: "{current()}", id: current(), csrf, session_scope, onexpired }
                        } else if tab() == Tab::Projects {
                            crate::projects_view::Projects { key: "{session_scope.read().generation()}", csrf, session_scope, onexpired,
                                onopen: move |(id, name): (String, String)| {
                                    linked.set(None);
                                    execution.write().select(&id, "");
                                    current.set(id);
                                                    title.set(name);
                                    tab.set(Tab::Chat);
                                    reload += 1;
                                }
                            }
                        } else if tab() == Tab::Timers {
                            crate::timer_screen::Timers { key: "{current()}-{session_scope.read().generation()}", conversation: current(), csrf, session_scope, onexpired }
                        } else if tab() == Tab::Tracker {
                            crate::tracker_view::Tracker { key:"{current()}-{session_scope.read().generation()}",conversation:current(),csrf,session_scope,onexpired }
                        } else if tab() == Tab::Memory {
                            crate::memory_view::MemoryView { key: "{session_scope.read().generation()}", csrf, project: None, session_scope, onexpired }
                        } else if tab() == Tab::LiveMap {
                            crate::live_map_view::LiveMapView { key: "{session_scope.read().generation()}", session_scope, onexpired }
                        } else if tab() == Tab::Host {
                            crate::host_dashboard::HostDashboard { key: "{session_scope.read().generation()}", session_scope, charts: host_charts, range: host_range, onexpired }
                        } else {
                            crate::chat_settings_view::ChatSettings { key: "settings-{current()}-{session_scope.read().generation()}", conversation: current(), csrf, session_scope, onexpired }
                            crate::beta_settings::BetaSettings {}
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn SelectedConversation(
    id: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    execution: Signal<orkestr_v2_ui::execution::Execution>,
    drafts: Signal<BTreeMap<String, Draft>>,
    held_inputs: Signal<orkestr_v2_ui::held_inputs::HeldInputs>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut ready = use_signal(|| false);
    let mut retry = use_signal(|| 0_u64);
    rsx! {
        if ready() {
            crate::views::Conversation { id, csrf, session_scope, execution, drafts, held_inputs, onexpired }
        } else {
            div { class: "conversation-loading",
                crate::beta_discovery::BetaDiscoveryGate {
                    key: "{retry}", conversation: Some(id), session_scope, onexpired,
                    onready: move |_| ready.set(true)
                }
                button { onclick: move |_| retry += 1, "Check conversation again" }
            }
        }
    }
}
