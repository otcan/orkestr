//! Minimal, bounded RFC 5322 / MIME decoding: unfolded headers, RFC 2047
//! encoded words, multipart walking, base64 and quoted-printable, a few
//! common charsets and HTML-to-text with link collection. Anything it does
//! not understand degrades to lossy UTF-8; it never panics on input.

/// Deepest multipart nesting that is walked.
const MAX_DEPTH: usize = 6;
/// Most MIME parts visited per message.
const MAX_PARTS: usize = 64;

#[derive(Debug, Clone, Default)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    /// First value of a header (name case-insensitive), raw (not decoded).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.0
            .iter()
            .filter(move |(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Split a raw message (or MIME part) into headers and body bytes.
pub fn split(raw: &[u8]) -> (Headers, &[u8]) {
    let (head, body) = match find_blank_line(raw) {
        Some((end, start)) => (&raw[..end], &raw[start..]),
        None => (raw, &raw[raw.len()..]),
    };
    let text = String::from_utf8_lossy(head);
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with([' ', '\t']) {
            if let Some((_, value)) = headers.last_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if !name.is_empty() && !name.contains(' ') && headers.len() < 512 {
                headers.push((name.to_owned(), value.trim().to_owned()));
            }
        }
    }
    (Headers(headers), body)
}

fn find_blank_line(raw: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'\n' {
            if raw.get(i + 1) == Some(&b'\n') {
                return Some((i, i + 2));
            }
            if raw.get(i + 1) == Some(&b'\r') && raw.get(i + 2) == Some(&b'\n') {
                return Some((i, i + 3));
            }
        }
        i += 1;
    }
    None
}

/// A parsed `Content-Type` (lower-case type and parameters).
#[derive(Debug, Clone)]
pub struct ContentType {
    pub mime: String,
    pub params: Vec<(String, String)>,
}
impl ContentType {
    pub fn parse(value: Option<&str>) -> Self {
        let value = value.unwrap_or("text/plain");
        let mut parts = split_params(value).into_iter();
        let mime = parts
            .next()
            .map(|p| p.trim().to_ascii_lowercase())
            .filter(|m| m.contains('/'))
            .unwrap_or_else(|| "text/plain".into());
        let params = parts
            .filter_map(|p| {
                let (k, v) = p.split_once('=')?;
                Some((
                    k.trim().to_ascii_lowercase(),
                    v.trim().trim_matches('"').to_owned(),
                ))
            })
            .collect();
        Self { mime, params }
    }
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Split on `;` outside double quotes.
fn split_params(value: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                out.last_mut().unwrap().push(c);
            }
            ';' if !quoted => out.push(String::new()),
            _ => out.last_mut().unwrap().push(c),
        }
    }
    out
}

/// Decoded readable content of a message.
#[derive(Debug, Clone, Default)]
pub struct Content {
    pub plain: Option<String>,
    pub html: Option<String>,
    pub html_links: Vec<String>,
}

/// Walk the MIME tree and keep the first text/plain and text/html parts
/// that are not attachments.
pub fn content(headers: &Headers, body: &[u8]) -> Content {
    let mut out = Content::default();
    let mut budget = MAX_PARTS;
    walk(headers, body, 0, &mut budget, &mut out);
    out
}

fn walk(headers: &Headers, body: &[u8], depth: usize, budget: &mut usize, out: &mut Content) {
    if *budget == 0 || depth > MAX_DEPTH {
        return;
    }
    *budget -= 1;
    let kind = ContentType::parse(headers.get("Content-Type"));
    if kind.mime.starts_with("multipart/") {
        let Some(boundary) = kind.param("boundary").filter(|b| !b.is_empty()) else {
            return;
        };
        for part in multipart_parts(body, boundary) {
            let (h, b) = split(part);
            walk(&h, b, depth + 1, budget, out);
        }
        return;
    }
    let attachment = headers
        .get("Content-Disposition")
        .is_some_and(|d| d.trim().to_ascii_lowercase().starts_with("attachment"));
    if attachment {
        return;
    }
    let decoded = transfer_decode(headers.get("Content-Transfer-Encoding"), body);
    let charset = kind.param("charset").unwrap_or("utf-8");
    match kind.mime.as_str() {
        "text/plain" if out.plain.is_none() => out.plain = Some(decode_charset(charset, &decoded)),
        "text/html" if out.html.is_none() => {
            let html = decode_charset(charset, &decoded);
            let (text, links) = html_to_text(&html);
            out.html = Some(text);
            out.html_links = links;
        }
        _ => {}
    }
}

fn multipart_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let delimiter = delimiter.as_bytes();
    let mut starts = Vec::new();
    let mut line_start = 0;
    while line_start < body.len() {
        let end = body[line_start..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(body.len(), |p| line_start + p);
        let line = &body[line_start..end];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.starts_with(delimiter) {
            let closing = line[delimiter.len()..].starts_with(b"--");
            starts.push((line_start, (end + 1).min(body.len()), closing));
            if closing {
                break;
            }
        }
        line_start = end + 1;
    }
    starts
        .windows(2)
        .filter(|w| !w[0].2)
        .map(|w| {
            let part = &body[w[0].1..w[1].0];
            let part = part.strip_suffix(b"\n").unwrap_or(part);
            part.strip_suffix(b"\r").unwrap_or(part)
        })
        .take(MAX_PARTS)
        .collect()
}

pub fn transfer_decode(encoding: Option<&str>, body: &[u8]) -> Vec<u8> {
    match encoding.map(|e| e.trim().to_ascii_lowercase()).as_deref() {
        Some("base64") => base64_decode(body),
        Some("quoted-printable") => quoted_printable(body, false),
        _ => body.to_vec(),
    }
}

pub fn base64_decode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let (mut acc, mut bits) = (0_u32, 0_u32);
    for &c in input {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Quoted-printable; `header` also maps `_` to space (RFC 2047 "Q").
pub fn quoted_printable(input: &[u8], header: bool) -> Vec<u8> {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        match input[i] {
            b'=' => {
                if let (Some(&a), Some(&b)) = (input.get(i + 1), input.get(i + 2)) {
                    if let (Some(h), Some(l)) = (hex(a), hex(b)) {
                        out.push(h << 4 | l);
                        i += 3;
                        continue;
                    }
                    if a == b'\r' && b == b'\n' {
                        i += 3;
                        continue;
                    }
                }
                if input.get(i + 1) == Some(&b'\n') {
                    i += 2;
                    continue;
                }
                out.push(b'=');
                i += 1;
            }
            b'_' if header => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Decode bytes in a declared charset. UTF-8, ASCII, Latin-1, Latin-9 and
/// Windows-1252 are exact; anything else falls back to lossy UTF-8.
pub fn decode_charset(charset: &str, bytes: &[u8]) -> String {
    let charset = charset.trim().trim_matches('"').to_ascii_lowercase();
    match charset.as_str() {
        "iso-8859-1" | "latin1" | "latin-1" | "iso8859-1" => bytes.iter().map(|&b| b as char).collect(),
        "iso-8859-15" | "latin9" => bytes
            .iter()
            .map(|&b| if b == 0xA4 { '€' } else { b as char })
            .collect(),
        "windows-1252" | "cp1252" => bytes.iter().map(|&b| cp1252(b)).collect(),
        _ => match std::str::from_utf8(bytes) {
            Ok(text) => text.to_owned(),
            Err(_) if charset == "us-ascii" => bytes.iter().map(|&b| cp1252(b)).collect(),
            Err(_) => String::from_utf8_lossy(bytes).into_owned(),
        },
    }
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) {
        HIGH[usize::from(b - 0x80)]
    } else {
        b as char
    }
}

/// Decode RFC 2047 encoded words in a header value.
pub fn decode_words(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let (before, after) = rest.split_at(start);
        let decoded = parse_word(after);
        match decoded {
            Some((text, used)) => {
                if !(last_was_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&text);
                rest = &after[used..];
                last_was_word = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = &after[2..];
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_word(word: &str) -> Option<(String, usize)> {
    let body = word.strip_prefix("=?")?;
    let (charset, body) = body.split_once('?')?;
    let (encoding, body) = body.split_once('?')?;
    let end = body.find("?=")?;
    let payload = &body[..end];
    let used = 2 + charset.len() + 1 + encoding.len() + 1 + end + 2;
    let charset = charset.split('*').next().unwrap_or(charset);
    let bytes = match encoding {
        "B" | "b" => base64_decode(payload.as_bytes()),
        "Q" | "q" => quoted_printable(payload.as_bytes(), true),
        _ => return None,
    };
    Some((decode_charset(charset, &bytes), used))
}

/// Visible text of an HTML body plus its `href` links.
pub fn html_to_text(html: &str) -> (String, Vec<String>) {
    let mut text = String::with_capacity(html.len() / 2);
    let mut links = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let Some(close) = html[i..].find('>') else { break };
            let tag = &lower[i + 1..i + close];
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if !tag.starts_with('/') && (name == "script" || name == "style" || name == "head") {
                let end = format!("</{name}");
                i = lower[i..].find(&end).map_or(bytes.len(), |p| i + p);
                continue;
            }
            if name == "a" {
                if let Some(href) = attribute(&html[i + 1..i + close], "href") {
                    if links.len() < 64 {
                        links.push(decode_entities(&href));
                    }
                }
            }
            if matches!(
                name.as_str(),
                "br" | "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "table" | "td"
            ) {
                text.push(if name == "td" { ' ' } else { '\n' });
            }
            i += close + 1;
            continue;
        }
        let next = html[i..].find('<').map_or(bytes.len(), |p| i + p);
        text.push_str(&decode_entities(&html[i..next]));
        i = next;
    }
    (text, links)
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))?;
    let value = &tag[at + name.len() + 1..];
    let value = value.trim_start();
    let (quote, value) = match value.chars().next()? {
        q @ ('"' | '\'') => (Some(q), &value[1..]),
        _ => (None, value),
    };
    let end = match quote {
        Some(q) => value.find(q)?,
        None => value.find(|c: char| c.is_whitespace()).unwrap_or(value.len()),
    };
    Some(value[..end].to_owned())
}

pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail[..tail.len().min(12)].find(';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "middot" => Some('·'),
            "ndash" => Some('–'),
            "mdash" => Some('—'),
            "auml" => Some('ä'),
            "ouml" => Some('ö'),
            "uuml" => Some('ü'),
            "szlig" => Some('ß'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
#[path = "mime_tests.rs"]
mod tests;
