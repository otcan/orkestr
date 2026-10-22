//! Renders a parsed message as elements. Text only ever becomes text nodes;
//! links are limited to http(s)/mailto by the parser.
use dioxus::prelude::*;
use orkestr_v2_ui::rich_text::{self, Align, Block, Inline, Marker};

#[component]
pub fn RichText(text: String) -> Element {
    let blocks = rich_text::parse(&text);
    rsx! {
        div { class: "rich-text",
            for (i, b) in blocks.iter().enumerate() { Fragment { key: "{i}", {block(b)} } }
        }
    }
}

fn block(b: &Block) -> Element {
    match b {
        Block::Paragraph(content) => rsx! { p { {inlines(content)} } },
        Block::Heading(level, content) => match level {
            1 => rsx! { h3 { class: "rt-h1", {inlines(content)} } },
            2 => rsx! { h4 { class: "rt-h2", {inlines(content)} } },
            _ => rsx! { h5 { class: "rt-h3", {inlines(content)} } },
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
                        span { class: "rt-item", {inlines(&item.content)} }
                    }
                }
            }
        },
        Block::Quote(inner) => rsx! {
            blockquote { class: "rt-quote",
                for (i, b) in inner.iter().enumerate() { Fragment { key: "{i}", {block(b)} } }
            }
        },
        Block::Reply(content) => rsx! {
            blockquote { class: "rt-reply", {inlines(content)} }
        },
        Block::Table { align, head, rows } => rsx! {
            div { class: "rt-table", tabindex: "0", role: "region", "aria-label": "Table",
                table {
                    thead { tr {
                        for (i, cell) in head.iter().enumerate() {
                            th { key: "{i}", class: align_class(align.get(i)), {inlines(cell)} }
                        }
                    } }
                    tbody {
                        for (r, row) in rows.iter().enumerate() {
                            tr { key: "{r}",
                                for (i, cell) in row.iter().enumerate() {
                                    td { key: "{i}", class: align_class(align.get(i)), {inlines(cell)} }
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

fn inlines(content: &[Inline]) -> Element {
    rsx! {
        for (i, node) in content.iter().enumerate() { Fragment { key: "{i}", {inline(node)} } }
    }
}

fn inline(node: &Inline) -> Element {
    match node {
        Inline::Text(t) => rsx! { "{t}" },
        Inline::Strong(c) => rsx! { strong { {inlines(c)} } },
        Inline::Em(c) => rsx! { em { {inlines(c)} } },
        Inline::Strike(c) => rsx! { s { {inlines(c)} } },
        Inline::Code(t) => rsx! { code { "{t}" } },
        Inline::Link { href, label } => rsx! {
            a { href: "{href}", target: "_blank", rel: "noopener noreferrer nofollow", {inlines(label)} }
        },
        Inline::Break => rsx! { br {} },
    }
}
