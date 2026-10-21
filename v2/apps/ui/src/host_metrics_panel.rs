//! Always-visible host summary: CPU, RAM and `/` disk with sparklines and a
//! live / stale / collecting state. One small revalidating GET every 10 s;
//! selecting it opens the details view.
use crate::host_metrics_chart::Sparkline;
use crate::host_metrics_fetch::{clock, sleep, start, Reply};
use dioxus::prelude::*;
use orkestr_v2_contracts::HostMetricsSummary;
use orkestr_v2_ui::{
    host_metrics::{self as model, Freshness, SUMMARY_REFRESH_MS},
    session_scope::SessionScope,
};
use serde_json::json;

/// Bumped by the heading panel; the workspace then shows the details tab.
#[derive(Clone, Copy)]
pub struct OpenHostMetrics(pub Signal<u64>);

#[component]
pub fn HostMetricsPanel(
    session_scope: Signal<SessionScope>,
    onopen: EventHandler<()>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut summary = use_signal(|| None::<HostMetricsSummary>);
    let mut received = use_signal(|| None::<i64>);
    let mut now = use_signal(|| 0_i64);
    let mut failed = use_signal(|| false);
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
    });
    use_future(move || async move {
        let mut etag: Option<String> = None;
        loop {
            let eval = start("/api/v2/host-metrics", etag.as_deref());
            channel.set(Some(eval));
            let reply = eval.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
            channel.set(None);
            let (wall, _) = clock().await;
            now.set(wall);
            match reply {
                Ok(Reply {
                    status: 200,
                    etag: tag,
                    text,
                }) => {
                    match serde_json::from_str::<HostMetricsSummary>(&text)
                        .ok()
                        .filter(HostMetricsSummary::is_valid)
                    {
                        Some(value) => {
                            summary.set(Some(value));
                            received.set(Some(wall));
                            etag = tag;
                            failed.set(false);
                        }
                        None => failed.set(true),
                    }
                }
                Ok(Reply { status: 304, .. }) => {
                    received.set(Some(wall));
                    failed.set(false);
                }
                Ok(Reply {
                    status: 401 | 403, ..
                }) => {
                    onexpired.call(());
                    return;
                }
                _ => failed.set(true),
            }
            sleep(SUMMARY_REFRESH_MS).await;
            if !mounted() || !session_scope.read().is_current(owner) {
                return;
            }
        }
    });
    let current = summary.read().clone();
    let state = model::freshness(current.as_ref(), now(), received());
    let (badge, badge_class) = match (state, failed()) {
        (_, true) if current.is_none() => ("unavailable", "stale"),
        (Freshness::Collecting, _) => ("collecting…", "collecting"),
        (Freshness::Stale, _) | (_, true) => ("stale", "stale"),
        (Freshness::Live, _) => ("live", "live"),
    };
    let updated = current
        .as_ref()
        .and_then(|s| s.observed_at_ms)
        .map(|at| format!("Updated {}", model::ago(now(), at)))
        .unwrap_or_else(|| "No sample yet".into());
    let s = current.unwrap_or_else(|| HostMetricsSummary {
        schema_version: 1,
        collecting: true,
        interval_ms: 5000,
        ..Default::default()
    });
    let cpu = s
        .cpu_percent
        .map(|v| model::percent(v.into()))
        .unwrap_or_else(|| "…".into());
    let memory_share = model::share(s.memory_used_bytes, s.memory_total_bytes);
    let memory = match (s.memory_used_bytes, s.memory_total_bytes) {
        (Some(used), Some(total)) => format!(
            "{} / {}",
            model::bytes(used as f64),
            model::bytes(total as f64)
        ),
        _ => "…".into(),
    };
    let disk_share = model::share(
        s.disk_used_bytes,
        s.disk_used_bytes.zip(s.disk_free_bytes).map(|(u, f)| u + f),
    );
    let disk = match s.disk_free_bytes {
        Some(free) => format!("{} free", model::bytes(free as f64)),
        None => "…".into(),
    };
    let title = format!("Host metrics · {updated} · open details");
    rsx! {
        button { class: "host-metrics-panel", r#type: "button", title: "{title}", "aria-label": "{title}",
            onclick: move |_| onopen.call(()),
            span { class: "hm-state {badge_class}", "{badge}" }
            span { class: "hm-item",
                span { class: "hm-label", "CPU" }
                strong { "{cpu}" }
                Sparkline { values: s.spark_cpu.clone(), class: "series-1" }
            }
            span { class: "hm-item",
                span { class: "hm-label", "RAM" }
                strong { title: "{memory}", {memory_share.map(model::percent).unwrap_or_else(|| "…".into())} }
                span { class: "hm-detail", "{memory}" }
                Sparkline { values: s.spark_memory.clone(), class: "series-2" }
            }
            span { class: "hm-item",
                span { class: "hm-label", "Disk /" }
                strong { {disk_share.map(model::percent).unwrap_or_else(|| "…".into())} }
                span { class: "hm-detail", "{disk}" }
                Sparkline { values: s.spark_disk.clone(), class: "series-3" }
            }
        }
    }
}
