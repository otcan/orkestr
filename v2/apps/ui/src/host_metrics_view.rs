//! Host metrics details: charts over 15 m, 1 h, 24 h or 7 d and the health
//! of the listed services. Reading only; refreshes while mounted.
use crate::host_metrics_chart::{Axis, CoreHeat, Line, LineChart, Unit};
use crate::host_metrics_fetch::{clock, sleep, start, Reply};
use dioxus::prelude::*;
use orkestr_v2_contracts::{HostMetricsHistory, HostMetricsRange, ServiceState};
use orkestr_v2_ui::{
    host_metrics::{self as model, history_refresh_ms},
    session_scope::SessionScope,
};
use serde_json::json;

#[derive(Clone, Copy, PartialEq)]
enum Notice {
    Loading,
    Unavailable,
}

#[component]
pub fn HostMetricsView(
    session_scope: Signal<SessionScope>,
    /// The URL keeps the range (`#host/details?range=…`).
    mut range: Signal<HostMetricsRange>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut history = use_signal(|| None::<HostMetricsHistory>);
    let mut notice = use_signal(|| Notice::Loading);
    let mut now = use_signal(|| 0_i64);
    let mut offset = use_signal(|| 0_i64);
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
    });
    // Restarts when the range changes (the previous read is aborted).
    use_resource(move || async move {
        let selected = range();
        if let Some(eval) = channel.peek().as_ref() {
            let _ = eval.send(json!({"stop": true}));
        }
        let path = format!("/api/v2/host-metrics/history?range={}", selected.label());
        let mut etag: Option<String> = None;
        loop {
            let eval = start(&path, etag.as_deref());
            channel.set(Some(eval));
            let reply = eval.join::<Reply>().await;
            if !mounted() || !session_scope.read().is_current(owner) || *range.peek() != selected {
                return;
            }
            channel.set(None);
            let (wall, zone) = clock().await;
            now.set(wall);
            offset.set(zone);
            match reply {
                Ok(Reply {
                    status: 200,
                    etag: tag,
                    text,
                }) => match serde_json::from_str::<HostMetricsHistory>(&text)
                    .ok()
                    .filter(|h| h.is_valid() && h.range == selected)
                {
                    Some(value) => {
                        history.set(Some(value));
                        etag = tag;
                    }
                    None => notice.set(Notice::Unavailable),
                },
                Ok(Reply { status: 304, .. }) => {}
                Ok(Reply {
                    status: 401 | 403, ..
                }) => {
                    onexpired.call(());
                    return;
                }
                _ => notice.set(Notice::Unavailable),
            }
            sleep(history_refresh_ms(selected)).await;
            if !mounted() || *range.peek() != selected {
                return;
            }
        }
    });
    let selected = range();
    let data = history.read().clone().filter(|h| h.range == selected);
    let ranges = rsx! {
        div { class: "hm-ranges", role: "group", "aria-label": "Time range",
            for r in HostMetricsRange::ALL {
                button { key: "{r.label()}", r#type: "button", "aria-pressed": if r == selected { "true" } else { "false" },
                    onclick: move |_| { if *range.peek() != r { history.set(None); notice.set(Notice::Loading); range.set(r); } },
                    "{r.label()}" }
            }
        }
    };
    let Some(h) = data else {
        let text = match notice() {
            Notice::Loading => "Loading host metrics…",
            Notice::Unavailable => "Host metrics are unavailable right now.",
        };
        return rsx! {
            section { class: "host-metrics", "aria-label": "Host metrics",
                header { class: "hm-header", h2 { "Charts" } {ranges} }
                p { class: "hm-empty", role: "status", "{text}" }
            }
        };
    };
    let end = h.observed_at_ms.unwrap_or(now()).max(now());
    let axis = Axis {
        from_ms: end - h.range.span_ms(),
        span_ms: h.range.span_ms(),
        step_ms: h.step_ms,
        offset_minutes: offset(),
        multi_day: h.range == HostMetricsRange::Days7,
        coverage: model::coverage(&h, end),
    };
    let times: Vec<i64> = h.points.iter().map(|p| p.t_ms).collect();
    let col =
        |f: &dyn Fn(&orkestr_v2_contracts::HostMetricsPoint) -> Option<f64>| -> Vec<Option<f64>> {
            h.points.iter().map(f).collect()
        };
    let partial = h
        .history_from_ms
        .filter(|from| *from > axis.from_ms + h.step_ms * 2);
    let collecting = h.points.len() < 2;
    let services_note = match h.services_observed_at_ms {
        Some(at) => format!("Checked {}", model::ago(now(), at)),
        None => "collecting…".into(),
    };
    let cores = h.cores;
    rsx! {
        section { class: "host-metrics", "aria-label": "Host metrics",
            header { class: "hm-header",
                div {
                    h2 { "Charts" }
                    p { class: "hm-sub",
                        "Whole host · {cores} cores · RAM {model::bytes(h.memory_total_bytes as f64)} · swap {model::bytes(h.swap_total_bytes as f64)} · / {model::bytes(h.disk_total_bytes as f64)}"
                    }
                }
                {ranges}
            }
            if collecting {
                p { class: "hm-empty", role: "status", "Collecting… samples are taken every 5 s; this range fills in as history accumulates." }
            } else if let Some(from) = partial {
                p { class: "hm-note", role: "status", "Collecting… history for this range starts {model::clock(from, offset(), axis.multi_day)} (shaded area has no samples yet)." }
            }
            if !collecting {
                div { class: "hm-grid",
                    LineChart { title: "CPU busy", times: times.clone(), unit: Unit::Percent, axis, fixed_max: Some(100.0), reference: None,
                        lines: vec![Line { label: "All cores", class: "series-1", values: col(&|p| Some(p.cpu.into())) }] }
                    LineChart { title: "Load average", times: times.clone(), unit: Unit::Plain, axis, fixed_max: None,
                        reference: Some(("cores".to_string(), cores as f64)),
                        lines: vec![
                            Line { label: "1 min", class: "series-1", values: col(&|p| Some(p.load1.into())) },
                            Line { label: "5 min", class: "series-2", values: col(&|p| Some(p.load5.into())) },
                            Line { label: "15 min", class: "series-3", values: col(&|p| Some(p.load15.into())) },
                        ] }
                    CoreHeat { times: times.clone(), cores: h.points.iter().map(|p| p.cores.clone()).collect::<Vec<_>>(), axis }
                    LineChart { title: "Memory", times: times.clone(), unit: Unit::Bytes, axis, fixed_max: Some(h.memory_total_bytes.max(h.swap_total_bytes) as f64),
                        reference: Some(("RAM total".to_string(), h.memory_total_bytes as f64)),
                        lines: vec![
                            Line { label: "Used", class: "series-1", values: col(&|p| Some(p.mem_used as f64)) },
                            Line { label: "Buff/cache", class: "series-2", values: col(&|p| Some(p.mem_cache as f64)) },
                            Line { label: "Swap used", class: "series-warn", values: col(&|p| Some(p.swap_used as f64)) },
                        ] }
                    LineChart { title: "Disk / used", times: times.clone(), unit: Unit::Bytes, axis, fixed_max: Some(h.disk_total_bytes as f64), reference: None,
                        lines: vec![Line { label: "Used", class: "series-3", values: col(&|p| Some(p.disk_used as f64)) }] }
                    LineChart { title: "Disk I/O", times: times.clone(), unit: Unit::Rate, axis, fixed_max: None, reference: None,
                        lines: vec![
                            Line { label: "Read", class: "series-1", values: col(&|p| Some(p.disk_read_bps.into())) },
                            Line { label: "Write", class: "series-4", values: col(&|p| Some(p.disk_write_bps.into())) },
                        ] }
                    LineChart { title: "Network", times: times.clone(), unit: Unit::Rate, axis, fixed_max: None, reference: None,
                        lines: vec![
                            Line { label: "Received", class: "series-2", values: col(&|p| Some(p.net_rx_bps.into())) },
                            Line { label: "Sent", class: "series-5", values: col(&|p| Some(p.net_tx_bps.into())) },
                        ] }
                    LineChart { title: "Rust app request latency", times: times.clone(), unit: Unit::Millis, axis, fixed_max: None, reference: None,
                        lines: vec![
                            Line { label: "p50", class: "series-1", values: col(&|p| p.req_p50_ms.map(f64::from)) },
                            Line { label: "p95", class: "series-warn", values: col(&|p| p.req_p95_ms.map(f64::from)) },
                        ] }
                    LineChart { title: "Rust app errors and traffic", times: times.clone(), unit: Unit::Percent, axis, fixed_max: None, reference: None,
                        lines: vec![
                            Line { label: "Error rate", class: "series-danger", values: col(&|p| p.req_error_rate.map(|r| f64::from(r) * 100.0)) },
                        ] }
                }
                p { class: "hm-foot",
                    "Requests: last minute of API traffic at each sample (static assets excluded); "
                    {h.points.last().map(|p| format!("{:.2} requests/s now.", p.req_rate)).unwrap_or_default()}
                }
            }
            section { class: "hm-services", "aria-label": "Service health",
                header { h3 { "Services" } span { class: "hm-sub", "{services_note}" } }
                if h.services.is_empty() {
                    p { class: "hm-empty", if h.services_observed_at_ms.is_some() { "No services are listed for this host (health-units.json)." } else { "Collecting…" } }
                } else {
                    ul {
                        for service in h.services.iter() {
                            li { key: "{service.unit}", class: if service.healthy { "svc ok" } else if service.state == ServiceState::Activating { "svc warn" } else { "svc bad" },
                                span { class: "svc-dot", "aria-hidden": "true" }
                                span { class: "svc-name", strong { "{service.label}" } small { "{service.unit}" } }
                                span { class: "svc-state",
                                    "{model::service_label(service, offset())}"
                                    if let Some(at) = service.since_ms.filter(|_| !service.oneshot) { small { " · since {model::ago(now(), at)}" } }
                                    if service.restarts > 0 { small { " · {service.restarts} restarts" } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
