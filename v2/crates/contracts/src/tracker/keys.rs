//! Stable dedupe keys: normalised company and role, canonical job URLs.

/// Legal-form words dropped from a company key.
const LEGAL_FORMS: [&str; 22] = [
    "gmbh",
    "mbh",
    "ag",
    "se",
    "kg",
    "kgaa",
    "ug",
    "ohg",
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "ltd",
    "limited",
    "llc",
    "plc",
    "co",
    "bv",
    "nv",
    "sa",
    "sarl",
    "ab",
];

fn words(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            word.push(c);
        } else if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// Stable company key: lower case, legal forms and punctuation removed
/// (`"Acme Robotics GmbH"` -> `"acme-robotics"`).
pub fn tracker_company_key(company: &str) -> String {
    words(company)
        .into_iter()
        .filter(|w| !LEGAL_FORMS.contains(&w.as_str()))
        .collect::<Vec<_>>()
        .join("-")
}

/// Stable role key: lower case, parenthesised parts (gender markers,
/// requisition ids, stacks) and punctuation removed
/// (`"DevOps Engineer (m/w/d)"` -> `"devops-engineer"`).
pub fn tracker_role_key(role: &str) -> String {
    let mut depth = 0_u32;
    let plain: String = role
        .chars()
        .filter(|c| match c {
            '(' | '[' => {
                depth += 1;
                false
            }
            ')' | ']' => {
                depth = depth.saturating_sub(1);
                false
            }
            _ => depth == 0,
        })
        .collect();
    words(&plain)
        .into_iter()
        .filter(|w| !matches!(w.as_str(), "m" | "w" | "d" | "f" | "x" | "all" | "genders"))
        .collect::<Vec<_>>()
        .join("-")
}

/// Query parameters that only track the click, never identify the job.
fn tracking_param(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("utm_")
        || matches!(
            name.as_str(),
            "trk"
                | "trkinfo"
                | "trackingid"
                | "refid"
                | "gclid"
                | "fbclid"
                | "lipi"
                | "midtoken"
                | "midsig"
                | "eid"
                | "otptoken"
                | "ref"
                | "src"
                | "source"
                | "mc_cid"
                | "mc_eid"
                | "_hsenc"
                | "_hsmi"
                | "lgtk"
                | "gh_src"
        )
}

/// Canonical job URL: scheme and host lower case, `www.` dropped, tracking
/// parameters and fragment removed, no trailing slash; LinkedIn job links
/// reduced to `https://linkedin.com/jobs/view/<id>`. `None` unless http(s).
pub fn tracker_canonical_url(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = rest.split('#').next().unwrap_or_default();
    let (authority, path_query) = match rest.find(['/', '?']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    if let Some(id) = linkedin_job_id_parts(&host, path_query) {
        return Some(format!("https://linkedin.com/jobs/view/{id}"));
    }
    let (path, query) = path_query.split_once('?').unwrap_or((path_query, ""));
    let path = path.trim_end_matches('/');
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| !tracking_param(pair.split('=').next().unwrap_or_default()))
        .collect();
    let mut out = format!("{scheme}://{host}{path}");
    if !kept.is_empty() {
        out.push('?');
        out.push_str(&kept.join("&"));
    }
    (out.len() <= 2048).then_some(out)
}

fn linkedin_job_id_parts(host: &str, path_query: &str) -> Option<String> {
    if host != "linkedin.com" && !host.ends_with(".linkedin.com") {
        return None;
    }
    let path = path_query.split('?').next().unwrap_or_default();
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let at = segments.windows(2).position(|w| w == ["jobs", "view"])?;
    let id = segments.get(at + 2)?;
    // `/jobs/view/backend-engineer-at-acme-4012345678` and plain ids.
    let digits: String = id.rsplit('-').next()?.to_owned();
    (digits.len() >= 6 && digits.len() <= 20 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then_some(digits)
}

/// The LinkedIn job id of a link, if it is one.
pub fn tracker_linkedin_job_id(url: &str) -> Option<String> {
    let canonical = tracker_canonical_url(url)?;
    canonical
        .strip_prefix("https://linkedin.com/jobs/view/")
        .map(str::to_owned)
}
