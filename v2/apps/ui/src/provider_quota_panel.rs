//! Independent completion-paced passive quota read; host gauges never wait for it.
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;
use serde::Deserialize;
use serde_json::json;
#[derive(Clone, Deserialize)]
struct Card {
    name: String,
    short: String,
    /// current, stale, expired, unknown or disconnected (`provider_quota.mjs`).
    state: String,
    label: String,
    /// Stale and/or limited, when the label does not already say it.
    chip: String,
    note: String,
    detail: String,
    reset: String,
}
#[derive(Deserialize)]
struct Reply {
    status: u16,
    cards: Vec<Card>,
}
#[component]
pub fn ProviderQuotaPanel(
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let mut cards = use_signal(Vec::<Card>::new);
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
    });
    use_future(move || async move {
        loop {
            let source = include_str!("provider_quota.mjs")
                .replace("export function", "function")
                .replace("export async function", "async function");
            let script = format!("{source}\nconst c=new AbortController();let done=false;dioxus.recv().then(()=>{{if(!done)c.abort();}});try{{return await providerQuotaRequest(c.signal);}}finally{{done=true;c.abort();}}");
            let eval = document::eval(&script);
            channel.set(Some(eval));
            let reply = eval.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(generation) {
                return;
            }
            channel.set(None);
            if let Ok(reply) = reply {
                if matches!(reply.status, 401 | 403) {
                    onexpired.call(());
                    return;
                }
                cards.set(reply.cards);
            } else {
                cards.set(Vec::new());
            }
            crate::host_metrics_fetch::sleep(30_000).await;
            if !mounted() || !session_scope.read().is_current(generation) {
                return;
            }
        }
    });
    rsx! { div { class: "provider-quota-panel", role: "group", "aria-label": "Provider quotas remaining",
        if cards.read().is_empty() { span { class: "quota-loading", "Reading quotas…" } }
        for card in cards.read().iter() {
            details { key: "{card.short}", class: "provider-quota-item", "data-state": "{card.state}", "name": "header-popover",
                onkeydown: move |event| {
                    if event.key() == Key::Escape {
                        close_open_popover();
                    }
                },
                summary {
                    span { class: "quota-provider", "{card.short}" }
                    span { class: "visually-hidden", " quota:" }
                    strong { class: "quota-label", "{card.label}" }
                    if !card.chip.is_empty() { small { class: "quota-state", "{card.chip}" } }
                }
                div { class: "quota-detail", role: "note",
                    h3 { "{card.name}" }
                    p { class: "quota-note", "{card.note}" }
                    p { "{card.detail}" }
                    if !card.reset.is_empty() { p { class: "quota-reset-detail", "{card.reset}" } }
                }
            }
        }
    } }
}

/// Escape closes the open header popover and returns focus to its summary.
pub fn close_open_popover() {
    let _ = document::eval(
        "const open=document.activeElement?.closest('details[open]');if(open){open.open=false;open.querySelector('summary')?.focus();}return null;",
    );
}
