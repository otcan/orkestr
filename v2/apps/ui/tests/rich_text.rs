use orkestr_v2_ui::rich_text::{
    inlines, parse, plain, safe_href, unescape, Align, Block, Inline, ListItem, Marker,
};

fn text(s: &str) -> Inline {
    Inline::Text(s.into())
}

#[test]
fn markdown_and_whatsapp_emphasis() {
    assert_eq!(
        inlines("a **bold** and *wa bold* _it_ ~strike~ ~~gone~~", 0),
        vec![
            text("a "),
            Inline::Strong(vec![text("bold")]),
            text(" and "),
            Inline::Strong(vec![text("wa bold")]),
            text(" "),
            Inline::Em(vec![text("it")]),
            text(" "),
            Inline::Strike(vec![text("strike")]),
            text(" "),
            Inline::Strike(vec![text("gone")]),
        ]
    );
    assert_eq!(
        inlines("**_both_**", 0),
        vec![Inline::Strong(vec![Inline::Em(vec![text("both")])])]
    );
}

#[test]
fn emphasis_needs_word_boundaries() {
    for literal in [
        "snake_case_name",
        "2*3*4",
        "a * b * c",
        "file_*.rs",
        "** not bold**",
        "unclosed *star",
    ] {
        assert_eq!(inlines(literal, 0), vec![text(literal)], "{literal}");
    }
}

#[test]
fn code_spans_are_verbatim() {
    assert_eq!(
        inlines("run `a *b* <i>` and ```x_y```", 0),
        vec![
            text("run "),
            Inline::Code("a *b* <i>".into()),
            text(" and "),
            Inline::Code("x_y".into()),
        ]
    );
    assert_eq!(
        inlines("*see `a*b`*", 0),
        vec![Inline::Strong(vec![
            text("see "),
            Inline::Code("a*b".into())
        ])]
    );
}

#[test]
fn links_are_web_or_mail_only() {
    let link = |href: &str, label: &str| Inline::Link {
        href: href.into(),
        label: vec![text(label)],
    };
    assert_eq!(
        inlines("[docs](https://ex.com/a_(b)) and https://ex.com/x_y.", 0),
        vec![
            link("https://ex.com/a_(b)", "docs"),
            text(" and "),
            link("https://ex.com/x_y", "https://ex.com/x_y"),
            text("."),
        ]
    );
    assert_eq!(
        inlines("(see https://ex.com/p)", 0),
        vec![
            text("(see "),
            link("https://ex.com/p", "https://ex.com/p"),
            text(")")
        ]
    );
    assert_eq!(
        inlines("[x](javascript:alert(1)) <data:text/html,hi>", 0),
        vec![text("[x](javascript:alert(1)) <data:text/html,hi>")]
    );
    assert_eq!(safe_href("JAVASCRIPT:alert(1)"), None);
    assert_eq!(safe_href("mailto:a@b.c").as_deref(), Some("mailto:a@b.c"));
}

#[test]
fn html_stays_text() {
    let blocks = parse("<script>alert(1)</script> <b>x</b>");
    assert_eq!(
        blocks,
        vec![Block::Paragraph(vec![text(
            "<script>alert(1)</script> <b>x</b>"
        )])]
    );
}

#[test]
fn headings_lists_rules_and_paragraph_breaks() {
    let blocks = parse("# Title\nline one\nline two\n\n- a\n  - nested\n1. one\n2) two\n\n---");
    assert_eq!(blocks[0], Block::Heading(1, vec![text("Title")]));
    assert_eq!(
        blocks[1],
        Block::Paragraph(vec![text("line one"), Inline::Break, text("line two")])
    );
    let Block::List(items) = &blocks[2] else {
        panic!("list expected: {blocks:?}")
    };
    assert_eq!(
        items
            .iter()
            .map(|i| (i.depth, i.marker.clone(), plain(&i.content)))
            .collect::<Vec<_>>(),
        vec![
            (0, Marker::Bullet, "a".into()),
            (1, Marker::Bullet, "nested".into()),
            (0, Marker::Number(1), "one".into()),
            (0, Marker::Number(2), "two".into()),
        ]
    );
    assert_eq!(blocks[3], Block::Rule);
}

#[test]
fn whatsapp_bullets_with_word_joiners() {
    let blocks = parse("Summary:\n•\u{2060}  \u{2060}*DPP-4* is an enzyme\n• _GLP-1_ peptide");
    assert_eq!(blocks[0], Block::Paragraph(vec![text("Summary:")]));
    assert_eq!(
        blocks[1],
        Block::List(vec![
            ListItem {
                depth: 0,
                marker: Marker::Bullet,
                content: vec![Inline::Strong(vec![text("DPP-4")]), text(" is an enzyme")],
            },
            ListItem {
                depth: 0,
                marker: Marker::Bullet,
                content: vec![Inline::Em(vec![text("GLP-1")]), text(" peptide")],
            },
        ])
    );
}

#[test]
fn bold_line_is_not_a_bullet() {
    assert_eq!(
        parse("*Status*: done"),
        vec![Block::Paragraph(vec![
            Inline::Strong(vec![text("Status")]),
            text(": done")
        ])]
    );
}

#[test]
fn fenced_code_is_verbatim_including_whatsapp_style() {
    assert_eq!(
        parse("```rust\nlet x = *y; // **no**\n  indented\n```\nafter"),
        vec![
            Block::Code {
                lang: "rust".into(),
                text: "let x = *y; // **no**\n  indented".into()
            },
            Block::Paragraph(vec![text("after")]),
        ]
    );
    assert_eq!(
        parse("```cargo build --offline\ncargo test```"),
        vec![Block::Code {
            lang: String::new(),
            text: "cargo build --offline\ncargo test".into()
        }]
    );
    // An unclosed fence keeps the rest as code.
    assert_eq!(
        parse("```\n# not a heading"),
        vec![Block::Code {
            lang: String::new(),
            text: "# not a heading".into()
        }]
    );
}

#[test]
fn tables_with_alignment_and_pipes_in_code() {
    let blocks = parse("| Gene | rsID |\n|---|---:|\n| `a|b` | **rs1** |\n| short |");
    let Block::Table { align, head, rows } = &blocks[0] else {
        panic!("table expected: {blocks:?}")
    };
    assert_eq!(align, &vec![Align::None, Align::Right]);
    assert_eq!(
        head.iter().map(|c| plain(c)).collect::<Vec<_>>(),
        ["Gene", "rsID"]
    );
    assert_eq!(rows[0][0], vec![Inline::Code("a|b".into())]);
    assert_eq!(rows[0][1], vec![Inline::Strong(vec![text("rs1")])]);
    assert_eq!(rows[1].len(), 2, "short rows are padded");
}

#[test]
fn reply_context_and_quotes() {
    let blocks = parse(
        "[WhatsApp: group]\n\n[Replying to Orkestr message from 15:23: \"Gmail: ok\"]\n\nWhich one?\n> quoted *x*",
    );
    assert_eq!(blocks[0], Block::Paragraph(vec![text("[WhatsApp: group]")]));
    assert_eq!(
        blocks[1],
        Block::Reply(vec![text(
            "Replying to Orkestr message from 15:23: \"Gmail: ok\""
        )])
    );
    assert_eq!(blocks[2], Block::Paragraph(vec![text("Which one?")]));
    assert_eq!(
        blocks[3],
        Block::Quote(vec![Block::Paragraph(vec![
            text("quoted "),
            Inline::Strong(vec![text("x")])
        ])])
    );
}

#[test]
fn literal_newline_escapes_only_when_they_dominate() {
    assert_eq!(unescape("a\\n\\nb\\n- c"), "a\n\nb\n- c");
    let code = "let re = \"\\n\";\nprintln!(\"\\n\");\nok";
    assert_eq!(unescape(code), code);
    assert_eq!(unescape("one \\n only"), "one \\n only");
}

#[test]
fn deep_nesting_is_bounded() {
    let deep = "*_~*_~*_~*_~x~_*~_*~_*~_*".repeat(50);
    let _ = parse(&deep);
    let quotes = ">".repeat(200) + " x";
    let _ = parse(&quotes);
}
