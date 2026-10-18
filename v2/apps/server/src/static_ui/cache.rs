//! Public build assets may be stored but must revalidate before reuse.
use axum::http::{header, HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};

pub(super) const POLICY: &str = "public, no-cache";

pub(super) fn etag(data: &[u8]) -> HeaderValue {
    format!("\"{:x}\"", Sha256::digest(data)).parse().unwrap()
}

pub(super) fn unchanged(headers: &HeaderMap, etag: &HeaderValue) -> bool {
    let mut combined = Vec::new();
    for value in headers.get_all(header::IF_NONE_MATCH) {
        if combined.len() + value.as_bytes().len() + 1 > 8192 {
            return false;
        }
        if !combined.is_empty() {
            combined.push(b',');
        }
        combined.extend_from_slice(value.as_bytes());
    }
    matches(&combined, etag.as_bytes()).unwrap_or(false)
}

fn trim(value: &[u8]) -> &[u8] {
    value.trim_ascii_start().trim_ascii_end()
}

// RFC9110 If-None-Match uses weak comparison for GET/HEAD. Parse the complete
// list before deciding: a comma inside an opaque quoted tag is not a separator,
// and malformed trailing input must not turn a partial match into a 304.
fn matches(mut value: &[u8], etag: &[u8]) -> Option<bool> {
    value = trim(value);
    if value == b"*" {
        return Some(true);
    }
    let mut matched = false;
    while !value.is_empty() {
        value = trim(value);
        if let Some(rest) = value.strip_prefix(b",") {
            value = rest;
            continue; // HTTP list recipients ignore empty list elements.
        }
        value = value.strip_prefix(b"W/").unwrap_or(value);
        let opaque = value.strip_prefix(b"\"")?;
        let end = opaque.iter().position(|byte| *byte == b'"')?;
        if !opaque[..end]
            .iter()
            .all(|byte| *byte == 0x21 || (0x23..=0x7e).contains(byte) || *byte >= 0x80)
        {
            return None;
        }
        matched |= &value[..end + 2] == etag;
        value = trim(&opaque[end + 1..]);
        if value.is_empty() {
            break;
        }
        value = value.strip_prefix(b",")?;
    }
    Some(matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_weak_lists_and_wildcards_revalidate() {
        let tag = etag(b"public bundle");
        let raw = tag.to_str().unwrap();
        for value in [
            raw.to_string(),
            format!("W/{raw}"),
            format!("\"other,tag\", W/{raw}"),
            "*".into(),
            format!(", , {raw},"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::IF_NONE_MATCH, value.parse().unwrap());
            assert!(unchanged(&headers, &tag));
        }
    }

    #[test]
    fn changed_content_and_malformed_headers_do_not_suppress_bodies() {
        let tag = etag(b"version one");
        assert_ne!(tag, etag(b"version two"));
        for value in [
            "",
            "different",
            "\"different\"",
            "w/\"wrong\"",
            "\"truncated",
            "*,\"other\"",
            "\"space in tag\"",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::IF_NONE_MATCH, value.parse().unwrap());
            assert!(!unchanged(&headers, &tag));
        }
        let mut headers = HeaderMap::new();
        headers.append(header::IF_NONE_MATCH, tag.clone());
        headers.append(header::IF_NONE_MATCH, "malformed".parse().unwrap());
        assert!(!unchanged(&headers, &tag));
        headers.insert(
            header::IF_NONE_MATCH,
            format!("\"{}\"", "a".repeat(8192)).parse().unwrap(),
        );
        assert!(!unchanged(&headers, &tag));
    }

    #[test]
    fn repeated_header_lines_form_one_list() {
        let tag = etag(b"public bundle");
        let mut headers = HeaderMap::new();
        headers.append(header::IF_NONE_MATCH, "\"old\"".parse().unwrap());
        headers.append(header::IF_NONE_MATCH, tag.clone());
        assert!(unchanged(&headers, &tag));
    }
}
