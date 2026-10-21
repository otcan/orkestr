//! URL screening for `fetch_url` (SSRF). A URL is checked lexically here and the
//! resolved addresses are checked again, then pinned, when the fetch runs.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub https: bool,
    pub host: String,
    pub port: u16,
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local
                || (seg[0] & 0xffc0) == 0xfe80 // link local
                || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
                || (seg[0] == 0x0064 && seg[1] == 0xff9b) // NAT64 can reach private v4
                || seg[0] == 0x2002 // 6to4 embeds arbitrary v4
                || v6 == Ipv6Addr::LOCALHOST)
        }
    }
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        || o[0] >= 240)
}

fn blocked_name(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".lan")
        || h.ends_with(".home")
        || h.ends_with(".corp")
        || h.ends_with(".intranet")
        || h.ends_with(".home.arpa")
        || !h.contains('.')
}

pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    allow.is_empty()
        || allow.iter().any(|rule| {
            let r = rule.to_ascii_lowercase();
            match r.strip_prefix("*.") {
                Some(suffix) => h.ends_with(&format!(".{suffix}")),
                None => h == r,
            }
        })
}

/// Lexical screening: scheme, userinfo, ambiguous numeric hosts, private literals and
/// internal names. Returns the target to resolve, or the reason it is refused.
pub fn screen(url: &str) -> Result<Target, String> {
    let (https, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("only http and https URLs are allowed".into());
    };
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err("URL contains forbidden characters".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("URL has no host".into());
    }
    if authority.contains('@') {
        return Err("URLs with credentials are not allowed".into());
    }
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (h, tail) = inner.split_once(']').ok_or("malformed IPv6 host")?;
        let port = match tail {
            "" => None,
            t => Some(t.strip_prefix(':').ok_or("malformed port")?),
        };
        (h.to_owned(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (authority.to_owned(), None),
        }
    };
    let port = match port {
        None => {
            if https {
                443
            } else {
                80
            }
        }
        Some(p) => p
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or("invalid port")?,
    };
    if host.is_empty() || host.len() > 253 {
        return Err("invalid host".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if public_ip(ip) {
            Ok(Target { https, host, port })
        } else {
            Err("that address is private, local or reserved".into())
        };
    }
    // No real TLD starts with a digit, so any such host is a decimal, octal or hex
    // spelling of an IPv4 address (2130706433, 0177.1, 0x7f.1, 127.1): refuse.
    if host
        .rsplit('.')
        .next()
        .is_some_and(|tld| tld.starts_with(|c: char| c.is_ascii_digit()))
    {
        return Err("numeric host spellings are not allowed".into());
    }
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err("invalid host".into());
    }
    if blocked_name(&host) {
        return Err("internal host names are not allowed".into());
    }
    Ok(Target { https, host, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_destinations_pass() {
        for u in [
            "https://example.com/a?b=1",
            "http://example.org:8080/x",
            "https://sub.example.co.uk",
            "http://93.184.216.34/",
            "https://[2606:4700::1111]/",
        ] {
            assert!(screen(u).is_ok(), "{u}: {:?}", screen(u));
        }
        assert_eq!(screen("https://example.com").unwrap().port, 443);
        assert_eq!(screen("http://example.com").unwrap().port, 80);
    }
    #[test]
    fn ssrf_shapes_are_refused() {
        for u in [
            "file:///etc/passwd",
            "ftp://example.com",
            "gopher://example.com",
            "javascript:alert(1)",
            "//example.com",
            "http://localhost/",
            "http://LOCALHOST./",
            "http://a.localhost/",
            "http://127.0.0.1/",
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://0/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:10.0.0.1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://metadata.google.internal/",
            "http://printer.local/",
            "http://intranet/",
            "http://user:pw@example.com/",
            "http://example.com@127.0.0.1/",
            "https://example.com:0/",
            "https://example.com:99999/",
            "http://exa mple.com/",
            "http://example.com\\@127.0.0.1/",
            "http://[64:ff9b::7f00:1]/",
            "http://[2002:7f00:1::]/",
            "http://224.0.0.1/",
            "http://255.255.255.255/",
            "http:///x",
        ] {
            assert!(screen(u).is_err(), "{u} should be refused");
        }
    }
    #[test]
    fn host_allowlist() {
        assert!(host_allowed("anything.com", &[]));
        let allow = vec!["example.com".to_owned(), "*.docs.rs".to_owned()];
        assert!(host_allowed("example.com", &allow));
        assert!(host_allowed("EXAMPLE.com.", &allow));
        assert!(host_allowed("a.docs.rs", &allow));
        assert!(!host_allowed("docs.rs", &allow));
        assert!(!host_allowed("evil-example.com", &allow));
        assert!(!host_allowed("example.com.evil.net", &allow));
    }
}
