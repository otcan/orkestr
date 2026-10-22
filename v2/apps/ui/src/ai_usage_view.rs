//! "Claude & Codex" on the host overview: plan headroom with reset
//! countdowns and pace, token use over time by model, who used the tokens,
//! what is working right now, the API-equivalent cost and cache efficiency.
use crate::host_metrics_poll::use_polled;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    AiConsumer, AiLimit, AiOwnerKind, AiProviderSummary, AiUsageWindow, HostAiUsage,
};
use orkestr_v2_ui::{
    ai_usage::{self as fmt, REFRESH_MS},
    host_metrics::{self as model},
    session_scope::SessionScope,
};

const CIRCUMFERENCE: f64 = 2.0 * std::f64::consts::PI * 42.0;

fn kind_label(kind: AiOwnerKind) -> &'static str {
    match kind {
        AiOwnerKind::Conversation => "Conversation",
        AiOwnerKind::Thread => "Thread",
        AiOwnerKind::Coordinator => "Coordinator",
        AiOwnerKind::Agent => "Agents",
        AiOwnerKind::Other => "Other",
    }
}

#[component]
fn LimitGauge(limit: AiLimit, now: i64, offset: i64, show_account: bool) -> Element {
    let pct = limit.used_percent.map(f64::from);
    let value = pct.unwrap_or(0.0).clamp(0.0, 100.0);
    let band = if limit.reached { "bad" } else { pct.map(model::level).unwrap_or("idle") };
    let dash = format!("{:.1} {:.1}", CIRCUMFERENCE * value / 100.0, CIRCUMFERENCE);
    let text = match pct {
        Some(p) => format!("{}{}", if limit.estimated { "≈" } else { "" }, model::percent(p)),
        None => "—".into(),
    };
    let left = pct.map(|p| format!("{} left", model::percent((100.0 - p).max(0.0))));
    let window = match (limit.window_tokens, limit.window_cost_usd) {
        (Some(t), Some(c)) => Some(format!("{} tokens · {} so far this window", fmt::tokens(t), fmt::usd(c))),
        _ => None,
    };
    rsx! {
        article { class: "ai-limit hd-gauge {band}",
            svg { class: "gauge-ring", view_box: "0 0 100 100", role: "img", "aria-label": "{limit.label} used {text}",
                circle { class: "gauge-track", cx: "50", cy: "50", r: "42" }
                circle { class: "gauge-value", cx: "50", cy: "50", r: "42", stroke_dasharray: "{dash}", transform: "rotate(-90 50 50)" }
                text { class: "gauge-text", x: "50", y: "55", text_anchor: "middle", "{text}" }
            }
            div { class: "gauge-body",
                h4 { "{limit.label}" if show_account { small { " · {limit.account}" } } }
                if let Some(left) = left { p { class: "ai-left", "{left}" } }
                if let Some(reset) = limit.resets_at_ms {
                    p { class: "ai-reset", "Resets {fmt::countdown(now, reset)} · {fmt::when(reset, now, offset)}" }
                }
                p { class: "ai-pace", "{fmt::pace(&limit, now, offset)}" }
                if let Some(w) = window { p { class: "hm-sub", "{w}" } }
                if let Some(note) = limit.note.as_ref() { p { class: "ai-note", "{note}" } }
            }
        }
    }
}

#[component]
fn ProviderCard(p: AiProviderSummary, now: i64, offset: i64) -> Element {
    let name = p.provider.label();
    let accounts: std::collections::BTreeSet<&String> = p.limits.iter().map(|l| &l.account).collect();
    let show_account = accounts.len() > 1;
    let burn = format!("{} tokens/min", fmt::tokens(p.burn_tokens_per_minute.round() as u64));
    let cost = p.burn_cost_per_hour_usd.map(|c| format!(" · {}/hour", fmt::usd(c)));
    let last = p.last_activity_ms.map(|t| format!("last reply {}", model::ago(now, t))).unwrap_or_else(|| "no replies in the last week".into());
    rsx! {
        article { class: "hd-card ai-provider ai-{name.to_lowercase()}",
            header { h3 { "{name}" } span { class: "hm-sub", "{last}" } }
            div { class: "ai-burn",
                span { class: "ai-burn-label", "Burn rate (last 30 min)" }
                strong { "{burn}" } if let Some(c) = cost { span { "{c}" } }
            }
            div { class: "ai-limits",
                if p.limits.is_empty() {
                    p { class: "hm-empty", "No plan limit reported yet." }
                }
                for (i, l) in p.limits.iter().enumerate() {
                    LimitGauge { key: "{i}", limit: l.clone(), now, offset, show_account }
                }
            }
            p { class: "hm-sub", "Last 5 hours: {fmt::tokens(p.last_5h.total())} tokens · last 7 days: {fmt::tokens(p.last_7d.total())} tokens" }
        }
    }
}

#[component]
fn TokenChart(w: AiUsageWindow, order: Vec<(orkestr_v2_contracts::AiProvider, String)>, now: i64, offset: i64) -> Element {
    let n = w.series.iter().map(|s| s.points.len()).max().unwrap_or(0);
    let max = model::nice_max(fmt::stacked_max(&w) as f64).max(1.0);
    let width = (n.max(1) * 10) as f64;
    let class_of = |s: &orkestr_v2_contracts::AiSeries| {
        fmt::series_class(order.iter().position(|(p, m)| *p == s.provider && *m == s.model))
    };
    let mut rects = Vec::new();
    for i in 0..n {
        let mut base = 0.0;
        let t = w.from_ms + i as i64 * w.step_ms;
        for s in &w.series {
            let v = s.points.get(i).copied().unwrap_or(0);
            if v == 0 {
                continue;
            }
            let h = v as f64 / max * 100.0;
            let y = 100.0 - base - h;
            base += h;
            let tip = format!("{} · {} {}: {} tokens", fmt::when(t, now, offset), s.provider.label(), s.model, fmt::tokens(v));
            rects.push((format!("{i}-{}", s.model), format!("{:.1}", i as f64 * 10.0 + 1.0), format!("{y:.2}"), format!("{h:.2}"), class_of(s), tip));
        }
    }
    let labels = fmt::axis_labels(&w, now, offset);
    let per_step = fmt::duration(w.step_ms);
    rsx! {
        figure { class: "metric-chart ai-chart",
            figcaption { span { class: "chart-title", "Tokens over time" } span { class: "chart-when", "per {per_step}, all kinds" } }
            ul { class: "chart-legend",
                for (i, (p, m)) in order.iter().enumerate() {
                    li { key: "{m}", class: "{fmt::series_class(Some(i))}", span { class: "swatch" } span { class: "legend-label", "{p.label()} · {m}" } }
                }
            }
            div { class: "chart-plot",
                div { class: "chart-y", span { "{fmt::tokens(max as u64)}" } span { "{fmt::tokens((max / 2.0) as u64)}" } span { "0" } }
                svg { class: "chart-svg", view_box: "0 0 {width} 100", preserve_aspect_ratio: "none", role: "img", "aria-label": "Tokens over time by model",
                    line { class: "chart-grid", x1: "0", x2: "{width}", y1: "50", y2: "50" }
                    line { class: "chart-grid", x1: "0", x2: "{width}", y1: "100", y2: "100" }
                    for (key, x, y, h, class, tip) in rects.into_iter() {
                        rect { key: "{key}", class: "ai-bar {class}", x: "{x}", y: "{y}", width: "8", height: "{h}", title { "{tip}" } }
                    }
                }
            }
            div { class: "chart-x", span { "{labels[0]}" } span { "{labels[1]}" } span { "{labels[2]}" } }
        }
    }
}

#[component]
fn Consumers(top: Vec<AiConsumer>) -> Element {
    let most = top.iter().map(|c| c.tokens.total()).max().unwrap_or(1).max(1) as f64;
    let rows: Vec<(AiConsumer, String, String)> = top
        .iter()
        .map(|c| {
            let width = format!("width: {:.1}%", c.tokens.total() as f64 * 100.0 / most);
            let tip = format!(
                "new input {} · output {} · cache read {} · cache write {}",
                fmt::tokens(c.tokens.input), fmt::tokens(c.tokens.output),
                fmt::tokens(c.tokens.cache_read), fmt::tokens(c.tokens.cache_write)
            );
            (c.clone(), width, tip)
        })
        .collect();
    rsx! {
        article { class: "hd-card ai-top",
            header { h3 { "Who used it" } span { class: "hm-sub", "by API-equivalent cost, then tokens" } }
            if top.is_empty() {
                p { class: "hm-empty", "No usage in this range." }
            } else {
                div { class: "consumer-table ai-table", role: "table", "aria-label": "Top consumers",
                    div { class: "consumer-row head", role: "row",
                        span { role: "columnheader", "Who" } span { role: "columnheader", "Tokens" }
                        span { role: "columnheader", "Est. cost" } span { role: "columnheader", "Active time" }
                    }
                    for (c, width, tip) in rows.iter() {
                        div { key: "{c.key}", class: "consumer-row", role: "row",
                            span { class: "who", role: "cell",
                                span { class: "kind ai-kind-{kind_label(c.kind).to_lowercase()}", "{kind_label(c.kind)}" }
                                if let Some(link) = c.link.as_ref() { a { href: "{link}", "{c.label}" } } else { strong { "{c.label}" } }
                                small { " · {c.models.join(\", \")}" }
                                if !c.roles.is_empty() { small { " · {c.roles.join(\", \")}" } }
                                span { class: "meter", span { style: "{width}" } }
                            }
                            span { class: "num", role: "cell", title: "{tip}", "{fmt::tokens(c.tokens.total())}" }
                            span { class: "num", role: "cell", {c.cost_usd.map(fmt::usd).unwrap_or_else(|| "—".into())} }
                            span { class: "num", role: "cell", "{fmt::duration(i64::from(c.active_minutes) * 60_000)}" }
                        }
                    }
                }
            }
        }
    }
}

#[component]
pub fn AiUsageSection(session_scope: Signal<SessionScope>, onexpired: EventHandler<()>) -> Element {
    let usage = use_polled::<HostAiUsage>("/api/v2/host/ai-usage", REFRESH_MS, session_scope, onexpired, HostAiUsage::is_valid);
    let mut range = use_signal(|| 1usize);
    let now = (usage.now_ms)();
    let offset = (usage.offset_minutes)();
    let Some(u) = usage.value.read().clone() else {
        let text = if (usage.failed)() { "Claude & Codex usage is unavailable right now." } else { "Loading Claude & Codex usage…" };
        return rsx! { section { class: "ai-usage", h2 { "Claude & Codex" } p { class: "hm-empty", role: "status", "{text}" } } };
    };
    let selected = range().min(u.windows.len().saturating_sub(1));
    let w = u.windows.get(selected).cloned();
    let order = u.windows.last().map(fmt::model_order).unwrap_or_default();
    let busiest = u.windows.last().and_then(|w| fmt::busiest_hour(w, offset));
    let updated = u.observed_at_ms.map(|t| format!("updated {}", model::ago(now, t))).unwrap_or_else(|| "collecting…".into());
    rsx! {
        section { class: "ai-usage", "aria-label": "Claude and Codex usage",
            header { class: "hd-header",
                div { h2 { "Claude & Codex" } p { class: "hm-sub", "Token use, plan headroom and who is using it · {updated}" } }
                if u.collecting {
                    span { class: "hd-state collecting",
                        {u.backfill_percent.map(|p| format!("reading history… {p:.0}%")).unwrap_or_else(|| "collecting…".into())}
                    }
                }
            }
            div { class: "ai-providers",
                for p in u.providers.iter() {
                    ProviderCard { key: "{p.provider.label()}", p: p.clone(), now, offset }
                }
            }
            div { class: "hm-ranges", role: "group", "aria-label": "Time range",
                for (i, win) in u.windows.iter().enumerate() {
                    button { key: "{win.range}", r#type: "button", "aria-pressed": if i == selected { "true" } else { "false" }, onclick: move |_| range.set(i), "Last {win.range}" }
                }
            }
            if let Some(w) = w {
                {
                    let cache = w.total.cache_hit_percent();
                    let shares = fmt::kind_shares(&w.total);
                    rsx! {
                        div { class: "ai-tiles",
                            article { class: "ai-tile", span { "Tokens" } strong { "{fmt::tokens(w.total.total())}" } small { "{w.total.requests} replies" } }
                            article { class: "ai-tile", span { "Cost if paid per token" } strong { "{fmt::usd(w.cost_usd)}" }
                                small { "{u.cost_basis}" if !w.unpriced_models.is_empty() { " · no price for {w.unpriced_models.join(\", \")}" } } }
                            article { class: "ai-tile", span { "Served from cache" } strong { {cache.map(|c| model::percent(c.into())).unwrap_or_else(|| "—".into())} }
                                small { "of all input was reused instead of re-read" } }
                            article { class: "ai-tile", span { "Busiest hour (7 days)" }
                                strong { {busiest.map(|(h, _)| format!("{h:02}:00–{:02}:00", (h + 1) % 24)).unwrap_or_else(|| "—".into())} }
                                small { {busiest.map(|(_, s)| format!("{s:.0}% of the week's tokens")).unwrap_or_default()} } }
                        }
                        div { class: "ai-kinds", role: "img", "aria-label": "Tokens by kind",
                            for (label, class, _, share) in shares.iter() {
                                span { key: "{label}", class: "ai-kind-seg {class}", style: "width: {share:.2}%", title: "{label}: {share:.1}%" }
                            }
                        }
                        ul { class: "chart-legend ai-kind-legend",
                            for (label, class, value, share) in shares.iter() {
                                li { key: "{label}", class: "{class}", span { class: "swatch" } span { class: "legend-label", "{label}" } strong { " {fmt::tokens(*value)}" } small { " ({share:.0}%)" } }
                            }
                        }
                        div { class: "ai-grid",
                            TokenChart { w: w.clone(), order: order.clone(), now, offset }
                            article { class: "hd-card ai-models",
                                header { h3 { "By model" } }
                                table {
                                    thead { tr { th { "Model" } th { "New input" } th { "Output" } th { "Cache read" } th { "Cache write" } th { "Est. cost" } } }
                                    tbody {
                                        for m in w.by_model.iter() {
                                            tr { key: "{m.model}",
                                                td { span { class: "swatch-dot {fmt::series_class(order.iter().position(|(p, n)| *p == m.provider && *n == m.model))}" } "{m.provider.label()} · {m.model}" }
                                                td { "{fmt::tokens(m.tokens.input)}" } td { "{fmt::tokens(m.tokens.output)}" }
                                                td { "{fmt::tokens(m.tokens.cache_read)}" } td { "{fmt::tokens(m.tokens.cache_write)}" }
                                                td { {m.cost_usd.map(fmt::usd).unwrap_or_else(|| "no price".into())} }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Consumers { top: w.top.clone() }
                    }
                }
            }
            div { class: "hd-two",
                article { class: "hd-card ai-active",
                    header { h3 { "Working now" } span { class: "hm-sub", "sessions with replies in the last 10 minutes" } }
                    if u.active.is_empty() {
                        p { class: "hm-empty", "Nothing is working right now." }
                    } else {
                        ul { class: "ai-list",
                            for (i, a) in u.active.iter().enumerate() {
                                li { key: "{i}",
                                    span { class: "kind ai-kind-{kind_label(a.kind).to_lowercase()}", "{a.provider.label()}" }
                                    if let Some(link) = a.link.as_ref() { a { href: "{link}", "{a.label}" } } else { strong { "{a.label}" } }
                                    small { " · {a.model.clone().unwrap_or_default()}" if let Some(r) = a.role.as_ref() { " · {r}" } }
                                    span { class: "ai-meta", "{fmt::tokens(a.tokens_10m)} tokens in 10 min · running {fmt::duration(now - a.started_at_ms)} · last reply {model::ago(now, a.last_activity_ms)}"
                                        if let (Some(c), Some(r)) = (a.cpu_percent, a.rss_bytes) { " · CPU {model::percent(c.into())} · {model::bytes(r as f64)}" } }
                                }
                            }
                        }
                    }
                }
                article { class: "hd-card ai-programs",
                    header { h3 { "Programs running" } span { class: "hm-sub", "Claude and Codex processes with their tools" } }
                    if u.processes.is_empty() {
                        p { class: "hm-empty", "No Claude or Codex program is running." }
                    } else {
                        ul { class: "ai-list",
                            for (i, p) in u.processes.iter().enumerate() {
                                li { key: "{i}",
                                    strong { "{p.label}" }
                                    span { class: "ai-meta", "CPU {model::percent(p.cpu_percent.into())} · {model::bytes(p.rss_bytes as f64)} · {p.processes} processes"
                                        if let Some(s) = p.started_at_ms { " · up {fmt::duration(now - s)}" } }
                                }
                            }
                        }
                    }
                }
            }
            p { class: "hm-foot",
                "Counted from Claude Code transcripts and Codex session logs on this host (numbers only, never message text): "
                {u.sources.iter().map(|s| format!("{} · {} ({} {})", s.provider.label(), s.label, s.files, if s.readable { "files" } else { "unreadable" })).collect::<Vec<_>>().join("; ")}
                ". Costs are an API-equivalent estimate at public list prices, not what a subscription bills. Cache reads are input the model reused at a lower price."
            }
        }
    }
}
