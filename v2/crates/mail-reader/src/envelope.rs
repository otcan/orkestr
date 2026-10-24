//! The normalised envelope every mail ingress yields (ORK-607 §5.1): hashed
//! message reference, date, sender, subject, bounded plain text, links and
//! the receiving server's authentication verdicts. No raw body is kept.
use crate::mime;
use sha2::{Digest, Sha256};

/// Plain text kept per message (characters).
pub const TEXT_MAX: usize = 50_000;
/// Links kept per message.
pub const LINKS_MAX: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthVerdict {
    /// `dkim`, `spf` or `dmarc`.
    pub method: String,
    /// `pass`, `fail`, `none`, ...
    pub result: String,
    /// The domain the verdict is about (`header.i`, `header.d`, `smtp.mailfrom`, `header.from`).
    pub domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// sha256 of the Message-ID (or identifying headers and body), first 24 hex.
    pub message_ref: String,
    pub date_ms: Option<i64>,
    pub from_name: String,
    pub from_addr: String,
    pub sender_domain: String,
    pub subject: String,
    pub text: String,
    pub links: Vec<String>,
    /// Server id of the topmost `Authentication-Results` header (the
    /// receiving provider's own verdict, e.g. `mx.google.com`).
    pub authserv: Option<String>,
    pub auth: Vec<AuthVerdict>,
    pub list_unsubscribe: bool,
    /// Bulk or marketing mail: `List-Unsubscribe`, `List-Id`, `Precedence:
    /// bulk|list|junk` or a mass-mailer campaign header.
    pub bulk: bool,
    /// Thunderbird marked it expunged (mbox `X-Mozilla-Status` 0x0008).
    pub expunged: bool,
    /// Recipients (`To`, then `Cc`): (display name, lower-case address).
    pub to: Vec<(String, String)>,
    /// Hashed `In-Reply-To` and `References` ids (same hash as `message_ref`).
    pub reply_refs: Vec<String>,
    /// Read from a Sent folder: the user's own outgoing mail.
    pub outgoing: bool,
}

/// `<a@x> <b@y>` -> each bracketed id.
fn ids(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = value;
    while let (Some(open), Some(close)) = (rest.find('<'), rest.find('>')) {
        if open < close {
            out.push(rest[open..=close].to_owned());
        }
        rest = &rest[close + 1..];
    }
    out
}

/// Split an address list on commas outside quotes and angle brackets.
fn address_list(value: &str) -> Vec<(String, String)> {
    let mut parts = vec![String::new()];
    let (mut quoted, mut angle) = (false, false);
    for c in value.chars() {
        match c {
            '"' => quoted = !quoted,
            '<' => angle = true,
            '>' => angle = false,
            ',' if !quoted && !angle => {
                parts.push(String::new());
                continue;
            }
            _ => {}
        }
        parts.last_mut().unwrap().push(c);
    }
    parts
        .iter()
        .map(|p| parse_address(p))
        .filter(|(_, a)| a.contains('@'))
        .take(20)
        .collect()
}

pub fn message_ref(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse one raw RFC 822 message.
pub fn parse(raw: &[u8]) -> Envelope {
    let (headers, body) = mime::split(raw);
    let header = |name: &str| mime::decode_words(headers.get(name).unwrap_or_default());
    let subject = one_line(&header("Subject"), 300);
    let (from_name, from_addr) = parse_address(&header("From"));
    let sender_domain = from_addr
        .rsplit_once('@')
        .map(|(_, d)| d.trim_end_matches('.').to_ascii_lowercase())
        .unwrap_or_default();
    let date_raw = headers.get("Date").unwrap_or_default();
    let date_ms = crate::date::parse_rfc2822_ms(date_raw);
    let id = headers
        .get("Message-ID")
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let message_ref = match id {
        Some(id) => message_ref(id),
        None => {
            let mut hash = Sha256::new();
            for name in ["From", "Date", "Subject", "To", "Cc"] {
                hash.update(headers.get(name).unwrap_or_default().as_bytes());
                hash.update(b"\n");
            }
            hash.update(body);
            hash.finalize()[..12]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        }
    };
    let content = mime::content(&headers, body);
    let mut text = content
        .plain
        .clone()
        .or(content.html.clone())
        .unwrap_or_default();
    if text.chars().count() > TEXT_MAX {
        text = text.chars().take(TEXT_MAX).collect();
    }
    let text = text.replace("\r\n", "\n");
    let mut links = Vec::new();
    for link in content
        .html_links
        .iter()
        .cloned()
        .chain(text_links(&text))
        .chain(content.html.as_deref().map(text_links).unwrap_or_default())
    {
        if links.len() >= LINKS_MAX {
            break;
        }
        if (link.starts_with("http://") || link.starts_with("https://")) && !links.contains(&link) {
            links.push(link);
        }
    }
    let (authserv, auth) = headers
        .all("Authentication-Results")
        .next()
        .map(parse_auth_results)
        .unwrap_or_default();
    let expunged = headers
        .get("X-Mozilla-Status")
        .and_then(|v| u32::from_str_radix(v.trim(), 16).ok())
        .is_some_and(|flags| flags & 0x0008 != 0);
    let precedence = headers
        .get("Precedence")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let bulk = headers.get("List-Unsubscribe").is_some()
        || headers.get("List-Id").is_some()
        || matches!(precedence.as_str(), "bulk" | "list" | "junk")
        || [
            "X-Campaign",
            "X-Campaign-Id",
            "X-Mailchimp-Campaign",
            "X-MC-User",
            "X-Mailgun-Tag",
            "X-Newsletter",
        ]
        .iter()
        .any(|h| headers.get(h).is_some());
    let mut to = address_list(&header("To"));
    to.extend(address_list(&header("Cc")));
    to.truncate(20);
    let mut reply_refs: Vec<String> = Vec::new();
    for id in ids(headers.get("In-Reply-To").unwrap_or_default())
        .into_iter()
        .chain(
            ids(headers.get("References").unwrap_or_default())
                .into_iter()
                .rev(),
        )
    {
        let hashed = crate::envelope::message_ref(&id);
        if !reply_refs.contains(&hashed) && reply_refs.len() < 20 {
            reply_refs.push(hashed);
        }
    }
    Envelope {
        message_ref,
        date_ms,
        from_name,
        from_addr,
        sender_domain,
        subject,
        text,
        links,
        authserv,
        auth,
        list_unsubscribe: headers.get("List-Unsubscribe").is_some(),
        bulk,
        expunged,
        to,
        reply_refs,
        outgoing: false,
    }
}

fn one_line(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// `"Name" <local@domain>` or a bare address -> (name, lower-case address).
pub fn parse_address(value: &str) -> (String, String) {
    let value = value.trim();
    if let (Some(open), Some(close)) = (value.rfind('<'), value.rfind('>')) {
        if open < close {
            let name = value[..open].trim().trim_matches('"').trim();
            let addr = value[open + 1..close].trim().to_ascii_lowercase();
            return (one_line(name, 120), addr);
        }
    }
    let addr = value
        .split_whitespace()
        .find(|w| w.contains('@'))
        .unwrap_or_default()
        .trim_matches(|c| c == '<' || c == '>' || c == '"')
        .to_ascii_lowercase();
    (String::new(), addr)
}

fn text_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (at, _) in text.match_indices("http") {
        let rest = &text[at..];
        if !(rest.starts_with("http://") || rest.starts_with("https://")) {
            continue;
        }
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | ')' | ']'))
            .unwrap_or(rest.len());
        let link = rest[..end].trim_end_matches(['.', ',', ';']);
        if link.len() > 10 && out.len() < LINKS_MAX {
            out.push(link.to_owned());
        }
    }
    out
}

/// `authserv-id; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=...`
pub fn parse_auth_results(value: &str) -> (Option<String>, Vec<AuthVerdict>) {
    let mut parts = value.split(';');
    let authserv = parts
        .next()
        .and_then(|p| p.split_whitespace().next())
        .map(|p| p.to_ascii_lowercase());
    let mut verdicts = Vec::new();
    for part in parts {
        let mut words = part.split_whitespace();
        let Some((method, result)) = words.next().and_then(|w| w.split_once('=')) else {
            continue;
        };
        let method = method.to_ascii_lowercase();
        if !matches!(method.as_str(), "dkim" | "spf" | "dmarc") {
            continue;
        }
        let domain = words
            .filter_map(|w| w.split_once('='))
            .find(|(k, _)| {
                matches!(
                    k.to_ascii_lowercase().as_str(),
                    "header.i" | "header.d" | "smtp.mailfrom" | "header.from"
                )
            })
            .map(|(_, v)| {
                let v = v.trim_matches(|c| c == '"' || c == '(' || c == ')');
                v.rsplit('@').next().unwrap_or(v).to_ascii_lowercase()
            })
            .unwrap_or_default();
        verdicts.push(AuthVerdict {
            method,
            result: result.to_ascii_lowercase(),
            domain,
        });
        if verdicts.len() >= 16 {
            break;
        }
    }
    (authserv, verdicts)
}

/// Organisational domain approximation (no public suffix list): the last two
/// labels, or three under a two-letter country code with a generic second
/// level (`example.co.uk`).
pub fn org_domain(domain: &str) -> String {
    let labels: Vec<&str> = domain.trim_end_matches('.').split('.').collect();
    let n = labels.len();
    let keep = if n >= 3
        && labels[n - 1].len() == 2
        && matches!(
            labels[n - 2],
            "co" | "com" | "org" | "net" | "gov" | "ac" | "edu"
        ) {
        3
    } else {
        2
    };
    labels[n.saturating_sub(keep)..].join(".")
}

impl Envelope {
    /// DKIM passed for the sender or a parent/child signing domain, as recorded
    /// by an explicitly trusted receiving server. Sibling domains are refused:
    /// the display-name approximation in `org_domain` is not a public suffix list.
    pub fn dkim_aligned(&self, trusted_authserv: &[String]) -> bool {
        let trusted = self
            .authserv
            .as_deref()
            .is_some_and(|s| trusted_authserv.iter().any(|t| t == s));
        trusted
            && !self.sender_domain.is_empty()
            && self.auth.iter().any(|v| {
                v.method == "dkim"
                    && v.result == "pass"
                    && !v.domain.is_empty()
                    && (v.domain == self.sender_domain
                        || self.sender_domain.ends_with(&format!(".{}", v.domain))
                        || v.domain.ends_with(&format!(".{}", self.sender_domain)))
            })
    }
}

#[cfg(test)]
#[path = "envelope_tests.rs"]
mod tests;
