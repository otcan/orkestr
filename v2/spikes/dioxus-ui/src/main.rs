use dioxus::prelude::*;
use gloo_timers::future::TimeoutFuture;
use orkestr_v2_ui_spike::{fixture_event, ClientView, WINDOW};

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let mut view = use_signal(ClientView::connected_fixture);
    let mut source_cursor = use_signal(|| 0_u64);
    let mut streaming = use_signal(|| true);
    let mut submitted = use_signal(|| String::from("No fixture input submitted."));
    use_future(move || async move {
        loop {
            TimeoutFuture::new(250).await;
            if streaming() {
                let Some(next) = source_cursor().checked_add(1) else {
                    streaming.set(false);
                    continue;
                };
                source_cursor.set(next);
                if view.read().connected {
                    view.write().apply(fixture_event(source_cursor()));
                }
            }
        }
    });
    let cursor = view.read().cursor();
    let connected = view.read().connected;
    let resync = view.read().resync_required;
    let events: Vec<_> = view.read().visible().iter().cloned().collect();
    rsx! {
        style { "{include_str!(\"style.css\")}" }
        main {
            h1 { "Orkestr 2.0 — UI fixture" }
            p { class: "notice", "Synthetic data only. No server, persistence, account, model or delivery. Reload discards this draft." }
            nav { "aria-label": "Prototype location", strong { "Assistant" } span { " / Global fixture conversation" } }
            section { "aria-labelledby": "stream-status",
                h2 { id: "stream-status", "Synthetic stream" }
                p { role: "status", "Cursor {cursor}; source {source_cursor}. Connected: {connected}. Snapshot required: {resync}." }
                button { onclick: move |_| streaming.set(!streaming()), if streaming() { "Pause fixture" } else { "Resume fixture" } }
                button { onclick: move |_| view.write().connected = false, disabled: !connected, "Disconnect fixture" }
                button {
                    disabled: connected,
                    onclick: move |_| {
                        let start = view.read().cursor().saturating_add(1);
                        let end = source_cursor();
                        if end.saturating_sub(start) < WINDOW as u64 {
                            for sequence in start..=end { view.write().apply(fixture_event(sequence)); }
                        } else {
                            let first = end.saturating_sub(WINDOW as u64 - 1).max(1);
                            view.write().snapshot(end, (first..=end).map(fixture_event).collect());
                        }
                        view.write().connected = true;
                    },
                    "Reconnect from cursor"
                }
                button { onclick: move |_| {
                    let Some(end) = source_cursor().checked_add(10_000) else { return; };
                    let first = end - WINDOW as u64 + 1;
                    view.write().snapshot(end, (first..=end).map(fixture_event).collect());
                    source_cursor.set(end);
                }, "Load synthetic 10,000-event snapshot" }
            }
            section { "aria-label": "Recent synthetic events",
                p { "Only the latest {WINDOW} batches are rendered. This is a bounded window, not history pagination." }
                ol { class: "events", "aria-live": "off",
                    for event in events {
                        li { key: "{event.sequence}", "{event.text}" }
                    }
                }
            }
            form {
                onsubmit: move |event| {
                    event.prevent_default();
                    if !view.read().draft.trim().is_empty() {
                        submitted.set("Input observed in memory only. Draft preserved; no durable acceptance.".into());
                    }
                },
                label { r#for: "composer", "Message (fixture only)" }
                textarea {
                    id: "composer", rows: 4, maxlength: 8192,
                    value: "{view.read().draft}",
                    oninput: move |event| view.write().draft = event.value(),
                    "aria-describedby": "composer-help"
                }
                p { id: "composer-help", "Typing remains enabled while the fixture streams. Enter inserts a new line; use the button to submit." }
                button { r#type: "submit", "Observe fixture input" }
                p { role: "status", "{submitted}" }
            }
        }
    }
}
