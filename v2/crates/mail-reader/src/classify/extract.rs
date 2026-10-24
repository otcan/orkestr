//! Extract application details and evidence from normalized message text.
use super::*;

pub(super) fn domain_company(domain: &str) -> Option<String> {
    let org = crate::envelope::org_domain(domain);
    let label = org.split('.').next().filter(|l| !l.is_empty())?;
    Some(
        label
            .split('-')
            .filter(|w| !w.is_empty())
            .map(|w| {
                let mut c = w.chars();
                c.next()
                    .map(|f| f.to_uppercase().chain(c).collect::<String>())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Company of an outgoing application's recipient: an organisation-looking
/// display name ("Acme Robotics GmbH"), else the domain's name.
pub(super) fn recipient_company(env: &Envelope, pack: &RulePack) -> Option<String> {
    let (name, address) = env.to.first()?;
    let lower = name.to_lowercase();
    let organisation = orkestr_v2_contracts::tracker_company_key(name)
        != lower.split_whitespace().collect::<Vec<_>>().join("-")
        || pack
            .extract
            .display_name_noise
            .iter()
            .any(|n| lower.split_whitespace().any(|w| w == n));
    if !name.is_empty() && organisation {
        let cleaned: Vec<&str> = name
            .split_whitespace()
            .filter(|w| {
                !pack
                    .extract
                    .display_name_noise
                    .iter()
                    .any(|n| *n == w.to_lowercase())
            })
            .collect();
        if !cleaned.is_empty() {
            return Some(cleaned.join(" "));
        }
    }
    domain_company(address.rsplit('@').next().unwrap_or_default())
}

pub(super) fn evidence(text: &Prepared, when: &Condition) -> String {
    let phrase = when
        .subject_any
        .iter()
        .chain(&when.any)
        .chain(when.all.iter().flatten())
        .map(|p| p.trim_end_matches('*'))
        .find(|p| text.all_lower.contains(*p));
    let snippet = match phrase.and_then(|p| text.all_lower.find(p).map(|at| (at, p.len()))) {
        Some((at, len)) => {
            let start = text.all_lower[..at]
                .char_indices()
                .rev()
                .nth(60)
                .map_or(0, |(i, _)| i);
            let tail = &text.all_lower[at + len..];
            let end = at + len + tail.char_indices().nth(80).map_or(tail.len(), |(i, _)| i);
            text.all_lower[start..end].to_owned()
        }
        None => text.subject_lower.clone(),
    };
    snippet
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(orkestr_v2_contracts::TRACKER_TEXT_MAX)
        .collect()
}

fn merge(into: &mut Captures, from: Captures) {
    into.company = into.company.take().or(from.company);
    into.role = into.role.take().or(from.role);
    into.location = into.location.take().or(from.location);
}

pub(super) fn extract(pack: &RulePack, text: &Prepared) -> Captures {
    let mut caps = Captures::default();
    for (templates, haystack) in [
        (&pack.extract.subject, &text.subject),
        (&pack.extract.body, &text.body),
    ] {
        for template in templates {
            if caps.company.is_some() && caps.role.is_some() {
                return caps;
            }
            if let Some(found) = Template::parse(template)
                .ok()
                .and_then(|t| t.find(haystack))
            {
                merge(&mut caps, found);
            }
        }
    }
    caps
}

pub(super) fn display_name_company(env: &Envelope, pack: &RulePack) -> Option<String> {
    let mut words: Vec<&str> = env.from_name.split_whitespace().collect();
    if let Some(at) = words.iter().position(|w| w.eq_ignore_ascii_case("via")) {
        words.truncate(at);
    }
    let name = words
        .into_iter()
        .filter(|w| {
            !pack
                .extract
                .display_name_noise
                .iter()
                .any(|n| n == &w.to_lowercase())
        })
        .collect::<Vec<_>>()
        .join(" ");
    let lower = name.to_lowercase();
    (!name.is_empty()
        && !pack
            .vendor_names
            .iter()
            .any(|v| lower == *v || lower.starts_with(&format!("{v} "))))
    .then_some(name)
}

pub(super) fn posting_link(env: &Envelope, pack: &RulePack) -> Option<String> {
    let canonical: Vec<String> = env
        .links
        .iter()
        .filter_map(|l| tracker_canonical_url(l))
        .collect();
    canonical
        .iter()
        .find(|l| l.starts_with("https://linkedin.com/jobs/view/"))
        .or_else(|| {
            canonical.iter().find(|l| {
                let host = link_host(l).unwrap_or_default();
                pack.sources
                    .iter()
                    .filter(|s| s.posting_links)
                    .any(|s| s.link_domains.iter().any(|d| domain_matches(&host, d)))
            })
        })
        .cloned()
}

/// Jobs listed in an alert: an item line, then its job link.
pub(super) fn alert_items(pack: &RulePack, body: &str) -> Vec<(Captures, Option<String>)> {
    let templates: Vec<Template> = pack
        .alerts
        .items
        .iter()
        .filter_map(|t| Template::parse(t).ok())
        .collect();
    let mut items: Vec<(Captures, Option<String>)> = Vec::new();
    for line in body.lines() {
        if items.len() >= pack.alerts.max_items {
            break;
        }
        let link = line
            .split_whitespace()
            .find(|w| w.starts_with("http"))
            .and_then(tracker_canonical_url);
        match (link, items.last_mut()) {
            (Some(link), Some((_, slot @ None))) => *slot = Some(link),
            (Some(_), _) => {}
            (None, _) => {
                if let Some(caps) = templates.iter().find_map(|t| t.find(line)) {
                    if caps.company.is_some() && caps.role.is_some() {
                        items.push((caps, None));
                    }
                }
            }
        }
    }
    items
}
