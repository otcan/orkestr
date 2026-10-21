//! Dependency-free SVG charts for the metrics panel: time-series lines with
//! a hover readout, a per-core heat strip and sparklines. Colours come from
//! CSS variables, so light and dark themes follow the page.
use dioxus::prelude::*;
use orkestr_v2_ui::host_metrics::{self as model, Frame};

const WIDTH: f64 = 600.0;
const HEIGHT: f64 = 150.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unit {
    Percent,
    Bytes,
    Rate,
    Millis,
    Plain,
}

impl Unit {
    pub fn format(self, value: f64) -> String {
        match self {
            Unit::Percent => model::percent(value),
            Unit::Bytes => model::bytes(value),
            Unit::Rate => model::rate(value),
            Unit::Millis => model::millis(value),
            Unit::Plain => format!("{value:.2}"),
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Line {
    pub label: &'static str,
    /// `series-1` … `series-5`, `series-warn`, `series-muted`.
    pub class: &'static str,
    pub values: Vec<Option<f64>>,
}

/// Time axis shared by every chart of one history response.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Axis {
    pub from_ms: i64,
    pub span_ms: i64,
    pub step_ms: i64,
    pub offset_minutes: i64,
    pub multi_day: bool,
    /// Share of the width (from the right) that has history.
    pub coverage: f64,
}

#[component]
pub fn LineChart(
    title: String,
    times: Vec<i64>,
    lines: Vec<Line>,
    unit: Unit,
    axis: Axis,
    /// Fixed scale (e.g. 100 for percent, total RAM); otherwise from the data.
    fixed_max: Option<f64>,
    /// Optional dashed reference (e.g. total RAM, core count).
    reference: Option<(String, f64)>,
) -> Element {
    let mut hover = use_signal(|| None::<usize>);
    let peak = lines
        .iter()
        .flat_map(|l| l.values.iter().flatten())
        .copied()
        .chain(reference.as_ref().map(|r| r.1))
        .fold(0.0_f64, f64::max);
    let max = fixed_max.unwrap_or_else(|| model::nice_max(peak));
    let frame = Frame {
        from_ms: axis.from_ms,
        span_ms: axis.span_ms,
        step_ms: axis.step_ms,
        width: WIDTH,
        height: HEIGHT,
        max,
    };
    let index = hover().filter(|i| *i < times.len());
    let shown = index.or(times.len().checked_sub(1));
    let when = match (index, shown) {
        (Some(i), _) => model::clock(times[i], axis.offset_minutes, axis.multi_day),
        (None, Some(_)) => "now".to_string(),
        _ => String::new(),
    };
    let cursor = index.map(|i| frame.x(times[i]));
    let empty_width = (1.0 - axis.coverage) * WIDTH;
    let column = if times.len() > 1 {
        frame.x(times[0] + axis.step_ms) - frame.x(times[0])
    } else {
        WIDTH
    };
    let x_labels = [0.0, 0.5, 1.0]
        .map(|f| model::clock(frame.t(f * WIDTH), axis.offset_minutes, axis.multi_day));
    rsx! {
        figure { class: "metric-chart",
            figcaption {
                span { class: "chart-title", "{title}" }
                span { class: "chart-when", "{when}" }
            }
            ul { class: "chart-legend",
                for line in lines.iter() {
                    li { key: "{line.label}", class: "{line.class}",
                        span { class: "swatch", "aria-hidden": "true" }
                        span { class: "legend-label", "{line.label}" }
                        strong { {shown.and_then(|i| line.values.get(i).copied().flatten()).map(|v| unit.format(v)).unwrap_or_else(|| "—".into())} }
                    }
                }
            }
            div { class: "chart-plot", onmouseleave: move |_| hover.set(None),
                div { class: "chart-y", span { "{unit.format(max)}" } span { "{unit.format(max / 2.0)}" } span { "0" } }
                svg { class: "chart-svg", view_box: "0 0 {WIDTH} {HEIGHT}", preserve_aspect_ratio: "none", role: "img", "aria-label": "{title}",
                    if empty_width > 1.0 {
                        rect { class: "chart-empty", x: "0", y: "0", width: "{empty_width}", height: "{HEIGHT}" }
                    }
                    for f in [0.25, 0.5, 0.75] {
                        line { key: "{f}", class: "chart-grid", x1: "0", x2: "{WIDTH}", y1: "{HEIGHT * f}", y2: "{HEIGHT * f}" }
                    }
                    if let Some((_, value)) = reference.as_ref() {
                        line { class: "chart-reference", x1: "0", x2: "{WIDTH}", y1: "{frame.y(*value)}", y2: "{frame.y(*value)}" }
                    }
                    for line in lines.iter() {
                        for (n, points) in model::polylines(&times.iter().copied().zip(line.values.iter().copied()).collect::<Vec<_>>(), &frame).into_iter().enumerate() {
                            polyline { key: "{line.label}-{n}", class: "chart-line {line.class}", points: "{points}" }
                        }
                    }
                    if let Some(x) = cursor {
                        line { class: "chart-cursor", x1: "{x}", x2: "{x}", y1: "0", y2: "{HEIGHT}" }
                    }
                    for (i, t) in times.iter().enumerate() {
                        rect { key: "{t}", class: "chart-hit", x: "{frame.x(*t) - column / 2.0}", y: "0", width: "{column.max(1.0)}", height: "{HEIGHT}",
                            onmouseenter: move |_| hover.set(Some(i)), onclick: move |_| hover.set(Some(i)) }
                    }
                }
            }
            div { class: "chart-x", for label in x_labels.iter() { span { "{label}" } } }
            if let Some((label, value)) = reference.as_ref() {
                p { class: "chart-note", "Dashed: {label} {unit.format(*value)}" }
            }
        }
    }
}

/// Per-core busy share as a heat strip: one row per core, newest on the right.
#[component]
pub fn CoreHeat(times: Vec<i64>, cores: Vec<Vec<f32>>, axis: Axis) -> Element {
    let mut hover = use_signal(|| None::<usize>);
    let count = cores.iter().map(Vec::len).max().unwrap_or(0);
    // At most 120 columns: neighbouring points are averaged.
    let group = times.len().div_ceil(120).max(1);
    let columns: Vec<(i64, Vec<f32>)> = times
        .chunks(group)
        .zip(cores.chunks(group))
        .map(|(t, c)| {
            let values = (0..count)
                .map(|core| {
                    let v: Vec<f32> = c.iter().filter_map(|row| row.get(core).copied()).collect();
                    if v.is_empty() {
                        0.0
                    } else {
                        v.iter().sum::<f32>() / v.len() as f32
                    }
                })
                .collect();
            (t[0], values)
        })
        .collect();
    let frame = Frame {
        from_ms: axis.from_ms,
        span_ms: axis.span_ms,
        step_ms: axis.step_ms * group as i64,
        width: WIDTH,
        height: HEIGHT,
        max: 1.0,
    };
    let width = if columns.len() > 1 {
        frame.x(columns[0].0 + frame.step_ms) - frame.x(columns[0].0)
    } else {
        4.0
    };
    let row = HEIGHT / count.max(1) as f64;
    let readout = hover()
        .and_then(|i| columns.get(i))
        .map(|(t, values)| {
            let busiest = values.iter().cloned().fold(0.0_f32, f32::max);
            let mean = values.iter().sum::<f32>() / values.len().max(1) as f32;
            format!(
                "{} · mean {} · busiest core {}",
                model::clock(*t, axis.offset_minutes, axis.multi_day),
                model::percent(mean.into()),
                model::percent(busiest.into())
            )
        })
        .unwrap_or_else(|| format!("{count} cores · darker is busier"));
    rsx! {
        figure { class: "metric-chart",
            figcaption { span { class: "chart-title", "Per-core CPU" } span { class: "chart-when", "{readout}" } }
            div { class: "chart-plot", onmouseleave: move |_| hover.set(None),
                div { class: "chart-y", span { "core 0" } span {} span { "core {count.saturating_sub(1)}" } }
                svg { class: "chart-svg heat", view_box: "0 0 {WIDTH} {HEIGHT}", preserve_aspect_ratio: "none", role: "img", "aria-label": "Per-core CPU usage",
                    for (i, (t, values)) in columns.iter().enumerate() {
                        g { key: "{t}",
                            for (core, value) in values.iter().enumerate() {
                                rect { key: "{core}", class: "heat-cell", x: "{frame.x(*t)}", y: "{core as f64 * row}", width: "{width.max(1.0)}", height: "{row}",
                                    fill_opacity: "{(0.06 + value / 100.0 * 0.94).min(1.0)}" }
                            }
                            rect { class: "chart-hit", x: "{frame.x(*t)}", y: "0", width: "{width.max(1.0)}", height: "{HEIGHT}",
                                onmouseenter: move |_| hover.set(Some(i)), onclick: move |_| hover.set(Some(i)) }
                        }
                    }
                }
            }
            div { class: "chart-x", for f in [0.0, 0.5, 1.0] { span { key: "{f}", "{model::clock(frame.t(f * WIDTH), axis.offset_minutes, axis.multi_day)}" } } }
        }
    }
}

/// Tiny trend line, 0..=100.
#[component]
pub fn Sparkline(values: Vec<f32>, class: &'static str) -> Element {
    let n = values.len();
    let points: String = values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let x = if n > 1 {
                i as f64 * 60.0 / (n - 1) as f64
            } else {
                60.0
            };
            let y = 18.0 - (f64::from(*v) / 100.0).clamp(0.0, 1.0) * 16.0 - 1.0;
            format!("{x:.1},{y:.1}")
        })
        .collect::<Vec<_>>()
        .join(" ");
    rsx! {
        svg { class: "sparkline {class}", view_box: "0 0 60 18", preserve_aspect_ratio: "none", "aria-hidden": "true",
            if n > 1 { polyline { points: "{points}" } }
        }
    }
}
