//! Renders a parsed message as elements. Text only ever becomes text nodes;
//! links are limited to http(s)/mailto by the parser. A link to a file on the
//! agent's machine is shown as an unavailable file, never as a download.
use dioxus::prelude::*;
use orkestr_v2_ui::rich_text::{self, Align, Block, Inline, Marker};

/// `attachments`: the message also carries attachment records (shown as file
/// cards), so an unavailable path can point there instead.
#[component]
pub fn RichText(text: String, #[props(default)] attachments: bool) -> Element {
    let blocks = rich_text::parse(&text);
    rsx! {
        div { class: "rich-text",
            for (i, b) in blocks.iter().enumerate() { Fragment { key: "{i}", {block(b, attachments)} } }
        }
    }
}

fn block(b: &Block, attached: bool) -> Element {
    match b {
        Block::Paragraph(content) => rsx! { p { {inlines(content, attached)} } },
        Block::Heading(level, content) => match level {
            1 => rsx! { h3 { class: "rt-h1", {inlines(content, attached)} } },
            2 => rsx! { h4 { class: "rt-h2", {inlines(content, attached)} } },
            _ => rsx! { h5 { class: "rt-h3", {inlines(content, attached)} } },
        },
        Block::Code { lang, text } => rsx! {
            pre { class: "rt-code", "data-lang": "{lang}", code { "{text}" } }
        },
        Block::List(items) => rsx! {
            ul { class: "rt-list",
                for (i, item) in items.iter().enumerate() {
                    li { key: "{i}", class: "rt-depth-{item.depth}",
                        span { class: "rt-marker", "aria-hidden": "true",
                            match item.marker { Marker::Bullet => "•".to_string(), Marker::Number(n) => format!("{n}.") }
                        }
                        span { class: "rt-item", {inlines(&item.content, attached)} }
                    }
                }
            }
        },
        Block::Quote(inner) => rsx! {
            blockquote { class: "rt-quote",
                for (i, b) in inner.iter().enumerate() { Fragment { key: "{i}", {block(b, attached)} } }
            }
        },
        Block::Reply(content) => rsx! {
            blockquote { class: "rt-reply", {inlines(content, attached)} }
        },
        Block::Table { align, head, rows } => rsx! {
            div { class: "rt-table", tabindex: "0", role: "region", "aria-label": "Table",
                table {
                    thead { tr {
                        for (i, cell) in head.iter().enumerate() {
                            th { key: "{i}", class: align_class(align.get(i)), {inlines(cell, attached)} }
                        }
                    } }
                    tbody {
                        for (r, row) in rows.iter().enumerate() {
                            tr { key: "{r}",
                                for (i, cell) in row.iter().enumerate() {
                                    td { key: "{i}", class: align_class(align.get(i)), {inlines(cell, attached)} }
                                }
                            }
                        }
                    }
                }
            }
        },
        Block::Rule => rsx! { hr {} },
    }
}

fn align_class(align: Option<&Align>) -> &'static str {
    match align {
        Some(Align::Center) => "rt-center",
        Some(Align::Right) => "rt-right",
        _ => "",
    }
}

fn inlines(content: &[Inline], attached: bool) -> Element {
    rsx! {
        for (i, node) in content.iter().enumerate() { Fragment { key: "{i}", {inline(node, attached)} } }
    }
}

fn inline(node: &Inline, attached: bool) -> Element {
    match node {
        Inline::Text(t) => rsx! { "{t}" },
        Inline::Strong(c) => rsx! { strong { {inlines(c, attached)} } },
        Inline::Em(c) => rsx! { em { {inlines(c, attached)} } },
        Inline::Strike(c) => rsx! { s { {inlines(c, attached)} } },
        Inline::Code(t) => rsx! { code { "{t}" } },
        Inline::Link { href, label } => rsx! {
            a { href: "{href}", target: "_blank", rel: "noopener noreferrer nofollow", {inlines(label, attached)} }
        },
        Inline::LocalFile { name, label } => {
            let (badge, why) = if attached {
                ("Not linked · see attached files", "This reply names a file on the agent's computer. It is not a download link; use the attached file cards of this message.")
            } else {
                ("Unavailable file", "This reply names a file on the agent's computer. No copy was attached, so it cannot be downloaded here.")
            };
            rsx! {
                span { class: "rt-file-unavailable", "data-file-name": "{name}", "data-attached": "{attached}", title: "{why}",
                    svg { class: "rt-file-icon", "aria-hidden": "true", view_box: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", stroke_width: "2", stroke_linecap: "round", stroke_linejoin: "round",
                        path { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }
                        path { d: "M14 3v5h5" }
                    }
                    span { class: "rt-file-label", {inlines(label, attached)} }
                    span { class: "rt-file-badge", "{badge}" }
                    span { class: "visually-hidden", ". {why}" }
                }
            }
        }
        Inline::Break => rsx! { br {} },
    }
}
