//! Message formatting: the Markdown agents write (headings, lists, tables,
//! code, links, emphasis) and the WhatsApp subset relayed chats use (`*bold*`,
//! `_italic_`, `~strike~`, "•" bullets, ``` code). Parsing only: the view
//! turns this tree into elements and text nodes, so message text is never
//! interpreted as HTML and only http(s)/mailto links are produced.

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Strike(Vec<Inline>),
    Code(String),
    Link { href: String, label: Vec<Inline> },
    Break,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Marker {
    Bullet,
    Number(u64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListItem {
    pub depth: u8,
    pub marker: Marker,
    pub content: Vec<Inline>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading(u8, Vec<Inline>),
    /// Fenced code, verbatim.
    Code {
        lang: String,
        text: String,
    },
    List(Vec<ListItem>),
    Quote(Vec<Block>),
    /// The relay's `[Replying to …]` context line.
    Reply(Vec<Inline>),
    Table {
        align: Vec<Align>,
        head: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
    },
    Rule,
}

const QUOTE_DEPTH: usize = 3;
const INLINE_DEPTH: usize = 4;

/// Parse a chat message into blocks.
pub fn parse(text: &str) -> Vec<Block> {
    let text = unescape(text);
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end()).collect();
    blocks(&lines, 0)
}

/// Text relayed as a JSON string shows literal `\n`. Only a message made
/// mostly of escaped line breaks is decoded; real code keeps its escapes.
pub fn unescape(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    let literal = text.matches("\\n").count();
    if literal >= 2 && literal > text.matches('\n').count() * 2 {
        text.replace("\\r\\n", "\n")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
    } else {
        text
    }
}

fn blocks(lines: &[&str], depth: usize) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if t.is_empty() {
            i += 1;
            continue;
        }
        if let Some((fence, first)) = fence_open(t) {
            let (block, next) = code(lines, i, fence, first);
            out.push(block);
            i = next;
            continue;
        }
        if let Some(block) = heading(t) {
            out.push(block);
            i += 1;
            continue;
        }
        if is_rule(t) {
            out.push(Block::Rule);
            i += 1;
            continue;
        }
        if i + 1 < lines.len() && t.contains('|') && separator(lines[i + 1].trim()).is_some() {
            let (block, next) = table(lines, i);
            out.push(block);
            i = next;
            continue;
        }
        if t.starts_with('>') {
            let mut inner = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                let rest = &lines[i].trim_start()[1..];
                inner.push(rest.strip_prefix(' ').unwrap_or(rest));
                i += 1;
            }
            if depth < QUOTE_DEPTH {
                out.push(Block::Quote(blocks(&inner, depth + 1)));
            } else {
                out.push(Block::Paragraph(joined(&inner)));
            }
            continue;
        }
        if t.starts_with("[Replying to ") {
            let start = i;
            while i < lines.len() && i - start < 8 && !lines[i].trim().ends_with(']') {
                i += 1;
            }
            if i < lines.len() && lines[i].trim().ends_with(']') {
                let mut inner: Vec<&str> = lines[start..=i].iter().map(|l| l.trim()).collect();
                inner[0] = &inner[0][1..];
                let last = inner.len() - 1;
                inner[last] = &inner[last][..inner[last].len() - 1];
                out.push(Block::Reply(joined(&inner)));
                i += 1;
                continue;
            }
            i = start;
        }
        if list_item(lines[i]).is_some() {
            let (block, next) = list(lines, i);
            out.push(block);
            i = next;
            continue;
        }
        let start = i;
        i += 1;
        while i < lines.len() && !lines[i].trim().is_empty() && !interrupts(lines, i) {
            i += 1;
        }
        out.push(Block::Paragraph(joined(&lines[start..i])));
    }
    out
}

/// A line that starts another block ends the paragraph before it.
fn interrupts(lines: &[&str], i: usize) -> bool {
    let t = lines[i].trim();
    fence_open(t).is_some()
        || heading(t).is_some()
        || t.starts_with('>')
        || list_item(lines[i]).is_some()
        || (i + 1 < lines.len() && t.contains('|') && separator(lines[i + 1].trim()).is_some())
}

fn joined(lines: &[&str]) -> Vec<Inline> {
    let mut out = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        if n > 0 {
            out.push(Inline::Break);
        }
        out.extend(inlines(line, 0));
    }
    out
}

/// "```lang" opens a fence. WhatsApp also writes "```code…" with the code on
/// the fence line; a single-line "```code```" stays inline.
fn fence_open(t: &str) -> Option<(&'static str, Option<&str>)> {
    let fence = if t.starts_with("```") {
        "```"
    } else if t.starts_with("~~~") {
        "~~~"
    } else {
        return None;
    };
    let rest = &t[3..];
    if rest.contains(fence) {
        return None;
    }
    let lang_like = rest.len() <= 20
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-_.#".contains(c));
    Some((fence, if lang_like { None } else { Some(rest) }))
}

fn code(lines: &[&str], start: usize, fence: &str, first: Option<&str>) -> (Block, usize) {
    let lang = if first.is_none() {
        lines[start].trim()[3..].to_string()
    } else {
        String::new()
    };
    let mut body: Vec<&str> = first.into_iter().collect();
    let mut i = start + 1;
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == fence {
            i += 1;
            break;
        }
        if let Some(head) = line.strip_suffix(fence) {
            body.push(head);
            i += 1;
            break;
        }
        body.push(line);
        i += 1;
    }
    (
        Block::Code {
            lang,
            text: body.join("\n"),
        },
        i,
    )
}

fn heading(t: &str) -> Option<Block> {
    let level = t.chars().take_while(|&c| c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = t[level..].strip_prefix(' ')?;
    let rest = rest.trim().trim_end_matches('#').trim_end();
    Some(Block::Heading(level as u8, inlines(rest, 0)))
}

fn is_rule(t: &str) -> bool {
    let compact: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3
        && ['-', '*', '_']
            .iter()
            .any(|&m| compact.chars().all(|c| c == m))
}

fn cells(row: &str) -> Vec<String> {
    let row = row.trim();
    let row = row.strip_prefix('|').unwrap_or(row);
    let row = row.strip_suffix('|').unwrap_or(row);
    let mut out = vec![String::new()];
    let mut chars = row.chars().peekable();
    let mut in_code = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                out.last_mut().unwrap().push('|');
                chars.next();
            }
            '`' => {
                in_code = !in_code;
                out.last_mut().unwrap().push(c);
            }
            '|' if !in_code => out.push(String::new()),
            _ => out.last_mut().unwrap().push(c),
        }
    }
    out.into_iter().map(|c| c.trim().to_string()).collect()
}

fn separator(t: &str) -> Option<Vec<Align>> {
    if !t.contains('-') || !t.chars().all(|c| "|:- \t".contains(c)) {
        return None;
    }
    cells(t)
        .iter()
        .map(|c| {
            let dashes = c.trim_matches(':');
            if dashes.is_empty() || !dashes.chars().all(|ch| ch == '-') {
                return None;
            }
            Some(match (c.starts_with(':'), c.ends_with(':')) {
                (true, true) => Align::Center,
                (true, false) => Align::Left,
                (false, true) => Align::Right,
                _ => Align::None,
            })
        })
        .collect()
}

fn table(lines: &[&str], start: usize) -> (Block, usize) {
    let head: Vec<Vec<Inline>> = cells(lines[start]).iter().map(|c| inlines(c, 0)).collect();
    let mut align = separator(lines[start + 1].trim()).unwrap_or_default();
    align.resize(head.len(), Align::None);
    let mut rows = Vec::new();
    let mut i = start + 2;
    while i < lines.len() && lines[i].contains('|') && !lines[i].trim().is_empty() {
        let mut row: Vec<Vec<Inline>> = cells(lines[i]).iter().map(|c| inlines(c, 0)).collect();
        row.resize(head.len().max(1), Vec::new());
        rows.push(row);
        i += 1;
    }
    (Block::Table { align, head, rows }, i)
}

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{2060}' || c == '\u{200b}'
}

/// `- item`, `* item`, `• item`, `1. item`, `2) item`, indented to nest.
fn list_item(line: &str) -> Option<ListItem> {
    let indent: usize = line
        .chars()
        .take_while(|&c| is_space(c))
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum();
    let t = line.trim_start_matches(is_space);
    let mut chars = t.char_indices();
    let (_, first) = chars.next()?;
    let (marker, rest) = if "-*+•◦▪‣".contains(first) {
        (Marker::Bullet, &t[first.len_utf8()..])
    } else if first.is_ascii_digit() {
        let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 9 {
            return None;
        }
        let after = &t[digits..];
        let rest = after
            .strip_prefix('.')
            .or_else(|| after.strip_prefix(')'))?;
        (Marker::Number(t[..digits].parse().ok()?), rest)
    } else {
        return None;
    };
    if !rest.starts_with(is_space) {
        return None;
    }
    let content = rest.trim_start_matches(is_space);
    if content.is_empty() && marker == Marker::Bullet && first != '•' {
        return None;
    }
    Some(ListItem {
        depth: (indent / 2).min(4) as u8,
        marker,
        content: inlines(content, 0),
    })
}

fn list(lines: &[&str], start: usize) -> (Block, usize) {
    let mut items: Vec<ListItem> = Vec::new();
    let mut i = start;
    while i < lines.len() {
        if let Some(item) = list_item(lines[i]) {
            items.push(item);
            i += 1;
            continue;
        }
        let t = lines[i].trim();
        if t.is_empty() {
            // A blank line between items keeps one list.
            let next = (i..lines.len()).find(|&j| !lines[j].trim().is_empty());
            match next {
                Some(j) if list_item(lines[j]).is_some() => {
                    i = j;
                    continue;
                }
                _ => break,
            }
        }
        // An indented line continues the item above it.
        if lines[i].starts_with("  ") && !interrupts(lines, i) {
            let last = items.last_mut().unwrap();
            last.content.push(Inline::Break);
            last.content.extend(inlines(t, 0));
            i += 1;
            continue;
        }
        break;
    }
    (Block::List(items), i)
}

/// Inline formatting within one line.
pub fn inlines(line: &str, depth: usize) -> Vec<Inline> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    let flush = |text: &mut String, out: &mut Vec<Inline>| {
        if !text.is_empty() {
            out.push(Inline::Text(std::mem::take(text)));
        }
    };
    while i < chars.len() {
        let c = chars[i];
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        if c == '\\' && i + 1 < chars.len() && "\\`*_~[]()#|<>!-.+{}".contains(chars[i + 1]) {
            text.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '`' {
            let run = chars[i..].iter().take_while(|&&c| c == '`').count();
            if let Some(end) = find_run(&chars, i + run, '`', run) {
                flush(&mut text, &mut out);
                let inner: String = chars[i + run..end].iter().collect();
                out.push(Inline::Code(trim_code(&inner)));
                i = end + run;
                continue;
            }
            text.extend(&chars[i..i + run]);
            i += run;
            continue;
        }
        if c == '[' {
            if let Some((label, href, next)) = markdown_link(&chars, i) {
                flush(&mut text, &mut out);
                let label = if depth < INLINE_DEPTH {
                    inlines(&label, depth + 1)
                } else {
                    vec![Inline::Text(label)]
                };
                out.push(Inline::Link { href, label });
                i = next;
                continue;
            }
        }
        if c == '<' {
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == '>') {
                let inner: String = chars[i + 1..i + 1 + end].iter().collect();
                if !inner.contains(char::is_whitespace) {
                    if let Some(href) = safe_href(&inner) {
                        flush(&mut text, &mut out);
                        out.push(Inline::Link {
                            href,
                            label: vec![Inline::Text(inner)],
                        });
                        i += end + 2;
                        continue;
                    }
                }
            }
        }
        if (c == 'h' || c == 'H') && prev.is_none_or(|p| !p.is_alphanumeric()) {
            if let Some(len) = bare_url(&chars[i..]) {
                let url: String = chars[i..i + len].iter().collect();
                if let Some(href) = safe_href(&url) {
                    flush(&mut text, &mut out);
                    out.push(Inline::Link {
                        href,
                        label: vec![Inline::Text(url)],
                    });
                    i += len;
                    continue;
                }
            }
        }
        if matches!(c, '*' | '_' | '~') && depth < INLINE_DEPTH {
            if let Some((node, next)) = emphasis(&chars, i, depth) {
                flush(&mut text, &mut out);
                out.push(node);
                i = next;
                continue;
            }
        }
        text.push(c);
        i += 1;
    }
    flush(&mut text, &mut out);
    out
}

fn trim_code(inner: &str) -> String {
    if inner.len() > 2 && inner.starts_with(' ') && inner.ends_with(' ') && inner.trim() != "" {
        inner[1..inner.len() - 1].to_string()
    } else {
        inner.to_string()
    }
}

/// The next run of exactly `len` `mark` characters at or after `from`.
fn find_run(chars: &[char], from: usize, mark: char, len: usize) -> Option<usize> {
    let mut j = from;
    while j < chars.len() {
        if chars[j] == mark {
            let run = chars[j..].iter().take_while(|&&c| c == mark).count();
            if run == len {
                return Some(j);
            }
            j += run;
        } else {
            j += 1;
        }
    }
    None
}

fn emphasis(chars: &[char], i: usize, depth: usize) -> Option<(Inline, usize)> {
    let mark = chars[i];
    let run = chars[i..].iter().take_while(|&&c| c == mark).count();
    if run > 2 {
        return None;
    }
    // Opening: not inside a word, and not followed by a space.
    if i > 0 && chars[i - 1].is_alphanumeric() {
        return None;
    }
    let start = i + run;
    if chars.get(start).is_none_or(|&c| is_space(c)) {
        return None;
    }
    let mut j = start;
    while j < chars.len() {
        if chars[j] == '`' {
            // Emphasis never closes inside a code span.
            let len = chars[j..].iter().take_while(|&&c| c == '`').count();
            j = find_run(chars, j + len, '`', len).map_or(j + len, |e| e + len);
            continue;
        }
        if chars[j] == mark {
            let len = chars[j..].iter().take_while(|&&c| c == mark).count();
            let after = chars.get(j + len);
            if len == run
                && j > start
                && !is_space(chars[j - 1])
                && after.is_none_or(|c| !c.is_alphanumeric())
            {
                let inner: String = chars[start..j].iter().collect();
                let content = inlines(&inner, depth + 1);
                let node = match (mark, run) {
                    ('~', _) => Inline::Strike(content),
                    ('_', 1) => Inline::Em(content),
                    _ => Inline::Strong(content),
                };
                return Some((node, j + len));
            }
            j += len;
            continue;
        }
        j += 1;
    }
    None
}

fn markdown_link(chars: &[char], i: usize) -> Option<(String, String, usize)> {
    let mut depth = 0;
    let mut close = None;
    for (k, &c) in chars.iter().enumerate().skip(i) {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(k);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let mut parens = 0;
    let mut end = None;
    for (k, &c) in chars.iter().enumerate().skip(close + 1) {
        match c {
            '(' => parens += 1,
            ')' => {
                parens -= 1;
                if parens == 0 {
                    end = Some(k);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let target: String = chars[close + 2..end].iter().collect();
    let url = target.split_whitespace().next().unwrap_or("");
    let url = url.trim_start_matches('<').trim_end_matches('>');
    let href = safe_href(url)?;
    let label: String = chars[i + 1..close].iter().collect();
    Some((label, href, end + 1))
}

/// Length of a bare http(s) URL, without trailing punctuation.
fn bare_url(chars: &[char]) -> Option<usize> {
    let head: String = chars
        .iter()
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if !(head.starts_with("https://") || head.starts_with("http://")) {
        return None;
    }
    let mut len = chars
        .iter()
        .take_while(|&&c| !c.is_whitespace() && !"<>\"`".contains(c))
        .count();
    loop {
        let last = chars[len - 1];
        let unbalanced = last == ')'
            && chars[..len].iter().filter(|&&c| c == '(').count()
                < chars[..len].iter().filter(|&&c| c == ')').count();
        if ".,;:!?'*_~]".contains(last) || unbalanced {
            len -= 1;
        } else {
            break;
        }
    }
    (len > head.find("//").unwrap_or(0) + 2).then_some(len)
}

/// Only web and mail links; anything else (javascript:, data:, …) stays text.
pub fn safe_href(url: &str) -> Option<String> {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let ok = (lower.starts_with("https://") && url.len() > 8)
        || (lower.starts_with("http://") && url.len() > 7)
        || (lower.starts_with("mailto:") && url.len() > 7);
    ok.then(|| url.to_string())
}

/// Plain text of inline content, for labels and tests.
pub fn plain(content: &[Inline]) -> String {
    content
        .iter()
        .map(|node| match node {
            Inline::Text(t) | Inline::Code(t) => t.clone(),
            Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => plain(c),
            Inline::Link { label, .. } => plain(label),
            Inline::Break => "\n".into(),
        })
        .collect()
}
