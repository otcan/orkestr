//! Host overview: usage gauges with colour bands, per-thread CPU, the top
//! consumers (conversations, workspaces, services) with sparklines and
//! links, filesystems with the largest directories, and service health.
use crate::host_metrics_chart::Sparkline;
use crate::host_metrics_poll::use_polled;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    ConsumerKind, HostConsumer, HostConsumers, HostDisks, HostMetricsHistory, HostMetricsSummary,
    ServiceState,
};
use orkestr_v2_ui::{
    host_metrics::{self as model, Freshness},
    session_scope::SessionScope,
};

const CIRCUMFERENCE: f64 = 2.0 * std::f64::consts::PI * 42.0;

#[component]
fn Gauge(
    label: String,
    percent: Option<f64>,
    detail: String,
    spark: Vec<f32>,
    spark_class: &'static str,
) -> Element {
    let value = percent.unwrap_or(0.0).clamp(0.0, 100.0);
    let band = percent.map(model::level).unwrap_or("idle");
    let dash = format!("{:.1} {:.1}", CIRCUMFERENCE * value / 100.0, CIRCUMFERENCE);
    let text = percent.map(model::percent).unwrap_or_else(|| "…".into());
    rsx! {
        article { class: "hd-gauge {band}",
            svg { class: "gauge-ring", view_box: "0 0 100 100", role: "img", "aria-label": "{label} {text}",
                circle { class: "gauge-track", cx: "50", cy: "50", r: "42" }
                circle { class: "gauge-value", cx: "50", cy: "50", r: "42", stroke_dasharray: "{dash}", transform: "rotate(-90 50 50)" }
                text { class: "gauge-text", x: "50", y: "55", text_anchor: "middle", "{text}" }
            }
            div { class: "gauge-body",
                h3 { "{label}" }
                p { "{detail}" }
                if spark.len() > 1 { Sparkline { values: spark.clone(), class: spark_class } }
            }
        }
    }
}

fn kind_class(kind: ConsumerKind) -> &'static str {
    match kind {
        ConsumerKind::Conversation => "k-conversation",
        ConsumerKind::Workspace => "k-workspace",
        ConsumerKind::Service => "k-service",
        ConsumerKind::Container => "k-container",
        ConsumerKind::Session => "k-session",
        ConsumerKind::Other => "k-other",
    }
}

fn io_text(c: &HostConsumer) -> String {
    match (c.io_read_bps, c.io_write_bps) {
        (Some(r), Some(w)) => format!("{} / {}", model::rate(r.into()), model::rate(w.into())),
        _ => "—".into(),
    }
}

#[component]
pub fn HostOverview(
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    oncharts: EventHandler<()>,
) -> Element {
    let summary = use_polled::<HostMetricsSummary>(
        "/api/v2/host-metrics",
        10_000,
        session_scope,
        onexpired,
        HostMetricsSummary::is_valid,
    );
    let consumers = use_polled::<HostConsumers>(
        "/api/v2/host-metrics/consumers",
        10_000,
        session_scope,
        onexpired,
        HostConsumers::is_valid,
    );
    let disks = use_polled::<HostDisks>(
        "/api/v2/host-metrics/disks",
        60_000,
        session_scope,
        onexpired,
        |d| d.schema_version == 1,
    );
    let recent = use_polled::<HostMetricsHistory>(
        "/api/v2/host-metrics/history?range=15m",
        30_000,
        session_scope,
        onexpired,
        HostMetricsHistory::is_valid,
    );
    let mut by_memory = use_signal(|| false);
    let now = (summary.now_ms)();
    let offset = (summary.offset_minutes)();
    let s = summary.value.read().clone();
    let state = model::freshness(s.as_ref(), now, (summary.received_ms)());
    let (badge, badge_class) = match (state, (summary.failed)()) {
        (_, true) if s.is_none() => ("unavailable", "stale"),
        (Freshness::Collecting, _) => ("collecting…", "collecting"),
        (Freshness::Stale, _) | (_, true) => ("stale", "stale"),
        (Freshness::Live, _) => ("live", "live"),
    };
    let s = s.unwrap_or_default();
    let updated = s
        .observed_at_ms
        .map(|at| format!("updated {}", model::ago(now, at)))
        .unwrap_or_else(|| "no sample yet".into());
    let mem = model::share(s.memory_used_bytes, s.memory_total_bytes);
    let swap = model::share(s.swap_used_bytes, s.swap_total_bytes);
    let load = s
        .load
        .map(|(one, _, _)| f64::from(one) * 100.0 / f64::from(s.cores.max(1)));
    let bytes = |v: Option<u64>| {
        v.map(|b| model::bytes(b as f64))
            .unwrap_or_else(|| "…".into())
    };
    let mounts = s.mounts.clone();
    let mut list = consumers
        .value
        .read()
        .as_ref()
        .map(|c| c.consumers.clone())
        .unwrap_or_default();
    if by_memory() {
        list.sort_by_key(|c| std::cmp::Reverse(c.rss_bytes));
    }
    let consumers_note = match consumers.value.read().as_ref() {
        None => "collecting…".to_string(),
        Some(c) if c.collecting => "collecting… (two samples, 10 s apart)".into(),
        Some(c) => format!(
            "{} groups · sampled every {} s{}",
            c.consumers.len(),
            c.interval_ms / 1000,
            c.observed_at_ms
                .map(|at| format!(" · {}", model::ago(now, at)))
                .unwrap_or_default()
        ),
    };
    let d = disks.value.read().clone();
    let services = recent
        .value
        .read()
        .as_ref()
        .map(|h| (h.services.clone(), h.services_observed_at_ms))
        .unwrap_or_default();
    rsx! {
        section { class: "host-overview", "aria-label": "Host overview",
            header { class: "hd-header",
                div {
                    h2 { "Host" }
                    p { class: "hm-sub", "{s.cores} CPU threads · {updated}" }
                }
                span { class: "hd-state {badge_class}", "{badge}" }
            }
            div { class: "hd-gauges",
                Gauge { label: "CPU".to_string(), percent: s.cpu_percent.map(f64::from), detail: format!("{} of {} threads busy", s.cpu_percent.map(|p| format!("{:.1}", f64::from(p) * f64::from(s.cores) / 100.0)).unwrap_or_else(|| "…".into()), s.cores), spark: s.spark_cpu.clone(), spark_class: "series-1" }
                Gauge { label: "Memory".to_string(), percent: mem, detail: format!("{} of {} used", bytes(s.memory_used_bytes), bytes(s.memory_total_bytes)), spark: s.spark_memory.clone(), spark_class: "series-2" }
                Gauge { label: "Swap".to_string(), percent: swap, detail: format!("{} of {} used", bytes(s.swap_used_bytes), bytes(s.swap_total_bytes)), spark: Vec::new(), spark_class: "series-warn" }
                Gauge { label: "Load".to_string(), percent: load, detail: s.load.map(|(a, b, c)| format!("{a:.2} · {b:.2} · {c:.2} (1/5/15 min)")).unwrap_or_else(|| "…".into()), spark: Vec::new(), spark_class: "series-3" }
                for m in mounts.iter() {
                    Gauge { key: "{m.mount}", label: format!("Disk {}", m.mount),
                        percent: model::share(Some(m.used_bytes), Some(m.used_bytes + m.free_bytes)),
                        detail: format!("{} used · {} free of {}", model::bytes(m.used_bytes as f64), model::bytes(m.free_bytes as f64), model::bytes(m.total_bytes as f64)),
                        spark: if m.mount == "/" { s.spark_disk.clone() } else { Vec::new() }, spark_class: "series-3" }
                }
            }
            crate::ai_usage_view::AiUsageSection { session_scope, onexpired }
            article { class: "hd-card hd-threads",
                header { h3 { "CPU threads" } span { class: "hm-sub", "busy % per logical CPU, last 5 s" } }
                if s.cpu_cores_percent.is_empty() {
                    p { class: "hm-empty", "Collecting…" }
                } else {
                    ol { class: "thread-bars",
                        for (i, v) in s.cpu_cores_percent.iter().enumerate() {
                            li { key: "{i}", class: "{model::level(f64::from(*v))}", title: "CPU {i}: {model::percent(f64::from(*v))}",
                                span { class: "bar", style: "height: {v.clamp(0.0, 100.0)}%" }
                                small { "{i}" }
                            }
                        }
                    }
                }
            }
            article { class: "hd-card hd-consumers",
                header {
                    h3 { "Top consumers" }
                    span { class: "hm-sub", "{consumers_note}" }
                    div { class: "hm-ranges", role: "group", "aria-label": "Sort",
                        button { r#type: "button", "aria-pressed": if !by_memory() { "true" } else { "false" }, onclick: move |_| by_memory.set(false), "CPU" }
                        button { r#type: "button", "aria-pressed": if by_memory() { "true" } else { "false" }, onclick: move |_| by_memory.set(true), "Memory" }
                    }
                }
                if list.is_empty() {
                    p { class: "hm-empty", "Collecting… process attribution needs two samples, 10 s apart." }
                } else {
                    div { class: "consumer-table", role: "table", "aria-label": "Top consumers",
                        div { class: "consumer-row head", role: "row",
                            span { role: "columnheader", "Who" } span { role: "columnheader", "CPU" } span { role: "columnheader", "Last 10 min" }
                            span { role: "columnheader", "Memory" } span { role: "columnheader", "Disk read / write" } span { role: "columnheader", "Proc." }
                        }
                        for c in list.iter() {
                            div { key: "{c.key}", class: "consumer-row", role: "row",
                                span { class: "who", role: "cell",
                                    span { class: "kind {kind_class(c.kind)}", "{model::kind_label(c.kind)}" }
                                    if let Some(id) = c.conversation_id.as_ref() {
                                        a { href: "#conversation/{id}", "{c.label}" }
                                    } else {
                                        strong { "{c.label}" }
                                    }
                                    if !c.roles.is_empty() { small { " · {c.roles.join(\", \")}" } }
                                    if let Some(cmd) = c.top_command.as_ref() { small { class: "cmd", " · {cmd}" } }
                                }
                                span { class: "num cpu {model::level(f64::from(c.cpu_percent) * 4.0)}", role: "cell", title: "{c.cores:.2} cores",
                                    "{model::percent(c.cpu_percent.into())}" small { " · {c.cores:.2} cores" } }
                                span { class: "spark", role: "cell", Sparkline { values: c.spark_cpu.iter().map(|v| (v * 4.0).min(100.0)).collect::<Vec<f32>>(), class: "series-1" } }
                                span { class: "num", role: "cell", "{model::bytes(c.rss_bytes as f64)}" }
                                span { class: "num io", role: "cell", "{io_text(c)}" }
                                span { class: "num", role: "cell", "{c.processes}" }
                            }
                        }
                    }
                    p { class: "hm-foot", "CPU is the share of the whole host (all {s.cores} threads). Conversations include their Deep, Fast and Worker sessions and tools; workspaces are V1 thread and Worker commands by working directory. Disk I/O shows — where the kernel keeps it private to another user." }
                }
            }
            div { class: "hd-two",
                article { class: "hd-card hd-disks",
                    header { h3 { "Disks" } if let (Some(r), Some(w)) = (s.disk_read_bps, s.disk_write_bps) { span { class: "hm-sub", "I/O now: read {model::rate(r.into())} · write {model::rate(w.into())}" } } }
                    for m in mounts.iter() {
                        {
                            let pct = model::share(Some(m.used_bytes), Some(m.used_bytes + m.free_bytes)).unwrap_or(0.0);
                            rsx! {
                                div { key: "{m.mount}", class: "mount-row {model::level(pct)}",
                                    div { class: "mount-head", strong { "{m.mount}" } small { " {m.device} · {m.fs_type}" } span { class: "num", "{model::percent(pct)}" } }
                                    div { class: "meter", span { style: "width: {pct.clamp(0.0, 100.0)}%" } }
                                    small { "{model::bytes(m.used_bytes as f64)} used · {model::bytes(m.free_bytes as f64)} free · {model::bytes(m.total_bytes as f64)} size" }
                                }
                            }
                        }
                    }
                    h4 { "Largest directories" }
                    match d.as_ref().map(|d| &d.directories) {
                        None => rsx! { p { class: "hm-empty", "Collecting…" } },
                        Some(dirs) if dirs.entries.is_empty() => rsx! {
                            p { class: "hm-empty", if dirs.running { "Measuring… (idle I/O priority, takes a minute or two)" } else { "Collecting… the first measurement starts two minutes after the server starts, then hourly." } }
                        },
                        Some(dirs) => {
                            let top = dirs.entries.first().map(|e| e.bytes).unwrap_or(1).max(1);
                            let root_used = mounts.iter().find(|m| m.mount == "/").map(|m| m.used_bytes);
                            rsx! {
                                ol { class: "dir-list",
                                    for e in dirs.entries.iter() {
                                        li { key: "{e.path}",
                                            span { class: "path", "{e.path}" }
                                            span { class: "meter", span { style: "width: {e.bytes as f64 * 100.0 / top as f64}%" } }
                                            span { class: "num", "{model::bytes(e.bytes as f64)}" }
                                        }
                                    }
                                }
                                p { class: "hm-foot",
                                    "Measured {dirs.observed_at_ms.map(|at| model::ago(now, at)).unwrap_or_default()}, refreshed hourly. Counts what the service user can read: {model::bytes(dirs.readable_bytes as f64)}"
                                    {root_used.map(|u| format!(" of {} used on /.", model::bytes(u as f64))).unwrap_or_default()}
                                    if dirs.running { " Measuring again now…" }
                                }
                            }
                        }
                    }
                }
                article { class: "hd-card hm-services",
                    header { h3 { "Services" } span { class: "hm-sub", {services.1.map(|at| format!("checked {}", model::ago(now, at))).unwrap_or_else(|| "collecting…".into())} } }
                    if services.0.is_empty() {
                        p { class: "hm-empty", if services.1.is_some() { "No services are listed for this host (health-units.json)." } else { "Collecting…" } }
                    } else {
                        ul {
                            for service in services.0.iter() {
                                li { key: "{service.unit}", class: if service.healthy { "svc ok" } else if service.state == ServiceState::Activating { "svc warn" } else { "svc bad" },
                                    span { class: "svc-dot", "aria-hidden": "true" }
                                    span { class: "svc-name", strong { "{service.label}" } small { "{service.unit}" } }
                                    span { class: "svc-state", "{model::service_label(service, offset)}"
                                        if let Some(at) = service.since_ms.filter(|_| !service.oneshot) { small { " · since {model::ago(now, at)}" } }
                                        if service.restarts > 0 { small { " · {service.restarts} restarts" } }
                                    }
                                }
                            }
                        }
                    }
                    button { class: "hd-open-charts", r#type: "button", onclick: move |_| oncharts.call(()), "Open charts (15 m – 7 d) →" }
                }
            }
        }
    }
}
