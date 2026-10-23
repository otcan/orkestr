//! Deterministic stage of the job-mail pipeline (ORK-607 §5.2): source
//! family and sender authenticity, drop rules, the first matching event
//! rule, then template extraction of company, role, location and job link.
//! Mail is data: nothing here follows links or interprets instructions.
use crate::envelope::Envelope;
use crate::rules::{Condition, Direction, EventRule, Gate, RulePack, SourceRule};
use crate::template::{Captures, Template};
use orkestr_v2_contracts::{tracker_canonical_url, TrackerEventInput, TrackerEventKind};

mod extract;
use extract::{
    alert_items, display_name_company, evidence, extract, posting_link, recipient_company,
};

/// Characters of body text used for matching and extraction.
const MATCH_TEXT_MAX: usize = 12_000;
pub const UNKNOWN_COMPANY: &str = "Unknown company";

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// One event, or one per job of an alert.
    Events {
        rule: String,
        authentic: bool,
        events: Vec<TrackerEventInput>,
    },
    Dropped {
        reason: String,
    },
}

/// Text prepared once per message.
struct Prepared {
    subject: String,
    subject_lower: String,
    body: String,
    all_lower: String,
}

fn normalize_lines(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() && out.ends_with("\n\n") {
            continue;
        }
        out.push_str(&line);
        out.push('\n');
        if out.len() > MATCH_TEXT_MAX * 2 {
            break;
        }
    }
    out.chars().take(MATCH_TEXT_MAX).collect()
}

/// Whole-word (or `prefix*`) phrase search in lower-case text.
pub fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    let (phrase, prefix) = match phrase.strip_suffix('*') {
        Some(p) => (p, true),
        None => (phrase, false),
    };
    if phrase.is_empty() {
        return false;
    }
    haystack.match_indices(phrase).any(|(at, _)| {
        let before = haystack[..at].chars().next_back();
        let after = haystack[at + phrase.len()..].chars().next();
        let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        boundary(before) && (prefix || boundary(after))
    })
}

fn domain_matches(domain: &str, pattern: &str) -> bool {
    domain == pattern || domain.ends_with(&format!(".{pattern}"))
}

fn link_host(link: &str) -> Option<String> {
    let canonical = tracker_canonical_url(link)?;
    let rest = canonical.split_once("://")?.1;
    Some(rest.split(['/', '?']).next()?.to_owned())
}

fn source_for<'a>(env: &Envelope, pack: &'a RulePack) -> Option<&'a SourceRule> {
    pack.sources
        .iter()
        .find(|s| {
            s.sender_domains
                .iter()
                .any(|d| domain_matches(&env.sender_domain, d))
        })
        .or_else(|| {
            let hosts: Vec<String> = env.links.iter().filter_map(|l| link_host(l)).collect();
            pack.sources.iter().find(|s| {
                s.link_domains
                    .iter()
                    .any(|d| hosts.iter().any(|h| domain_matches(h, d)))
            })
        })
}

fn source_matches(source: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        p == source
            || (p == "known" && source != "direct")
            || p.strip_suffix('*')
                .is_some_and(|prefix| source.starts_with(prefix))
    })
}

fn holds(when: &Condition, env: &Envelope, source: &str, text: &Prepared) -> bool {
    let local = env.from_addr.split('@').next().unwrap_or_default();
    (when.from_prefix.is_empty()
        || when
            .from_prefix
            .iter()
            .any(|p| local.starts_with(p.as_str())))
        && (when.sources.is_empty() || source_matches(source, &when.sources))
        && !source_matches(source, &when.not_sources)
        && (when.any.is_empty() || when.any.iter().any(|p| contains_phrase(&text.all_lower, p)))
        && when
            .all
            .iter()
            .all(|group| group.iter().any(|p| contains_phrase(&text.all_lower, p)))
        && !when
            .none
            .iter()
            .any(|p| contains_phrase(&text.all_lower, p))
        && (when.subject_any.is_empty()
            || when
                .subject_any
                .iter()
                .any(|p| contains_phrase(&text.subject_lower, p)))
        && when.bulk.is_none_or(|b| b == env.bulk)
        && when
            .in_reply
            .is_none_or(|r| r == !env.reply_refs.is_empty())
}

/// `Re: AW: Fwd: Subject` -> `Subject`.
pub fn core_subject(subject: &str) -> &str {
    let mut rest = subject.trim();
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(prefix) = ["re:", "aw:", "wg:", "fwd:", "fw:", "antw:", "re :", "aw :"]
            .iter()
            .find(|p| lower.starts_with(*p))
        else {
            return rest;
        };
        rest = rest[prefix.len()..].trim_start();
    }
}

/// The source a recipient's domain belongs to (outgoing mail).
fn source_for_recipients<'a>(env: &Envelope, pack: &'a RulePack) -> Option<&'a SourceRule> {
    env.to.iter().find_map(|(_, address)| {
        let domain = address.rsplit('@').next().unwrap_or_default();
        pack.sources
            .iter()
            .find(|s| s.sender_domains.iter().any(|d| domain_matches(domain, d)))
    })
}

/// "acme-robotics.example" -> "Acme Robotics".
/// Classify one message. `fallback_ms` dates mail without a usable `Date`.
pub fn classify(env: &Envelope, pack: &RulePack, fallback_ms: i64) -> Outcome {
    let dropped = |reason: &str| Outcome::Dropped {
        reason: reason.to_owned(),
    };
    let body = normalize_lines(&env.text);
    let subject = core_subject(&env.subject).to_owned();
    let text = Prepared {
        subject_lower: subject.to_lowercase(),
        all_lower: format!("{subject}\n{body}").to_lowercase(),
        subject,
        body,
    };
    let direction = if env.outgoing {
        Direction::Outgoing
    } else {
        Direction::Incoming
    };
    let (source_rule, trusted) = if env.outgoing {
        (source_for_recipients(env, pack), false)
    } else {
        if pack
            .deny_senders
            .iter()
            .any(|d| domain_matches(&env.sender_domain, d))
        {
            return dropped("denylisted_sender");
        }
        let rule = source_for(env, pack);
        let authentic = env.dkim_aligned(&pack.trusted_authserv);
        // A spoofable family (LinkedIn) must prove its sender; a link to it in
        // someone else's mail does not make that mail LinkedIn's.
        let claimed = rule.is_some_and(|s| {
            s.require_dkim
                && s.sender_domains
                    .iter()
                    .any(|d| domain_matches(&env.sender_domain, d))
        });
        if claimed && !authentic {
            return dropped("sender_not_authenticated");
        }
        (rule, rule.is_some_and(|s| s.trusted) && authentic)
    };
    let source = source_rule.map_or("direct", |s| s.id.as_str());
    if !env.outgoing {
        if let Some(rule) = pack
            .drop
            .iter()
            .find(|r| holds(&r.when, env, source, &text))
        {
            return dropped(&format!("drop:{}", rule.id));
        }
    }
    let Some(rule) = pack
        .rules
        .iter()
        .find(|r| r.direction == direction && holds(&r.when, env, source, &text))
    else {
        return dropped(if env.outgoing {
            "outgoing_not_application"
        } else {
            "not_job_related"
        });
    };
    let requires_thread = match rule.gate {
        Gate::None => false,
        Gate::Trusted => !trusted,
        Gate::Thread => true,
    };
    if requires_thread && env.reply_refs.is_empty() {
        return dropped("not_in_thread");
    }
    if env.outgoing && !requires_thread && source_rule.is_none() {
        let private = env.to.first().is_none_or(|(_, a)| {
            let domain = a.rsplit('@').next().unwrap_or_default();
            pack.freemail_domains
                .iter()
                .any(|d| domain_matches(domain, d))
        });
        if private {
            return dropped("private_recipient");
        }
    }
    events(
        env,
        pack,
        rule,
        source_rule,
        requires_thread,
        &text,
        fallback_ms,
    )
}

fn events(
    env: &Envelope,
    pack: &RulePack,
    rule: &EventRule,
    source_rule: Option<&SourceRule>,
    requires_thread: bool,
    text: &Prepared,
    fallback_ms: i64,
) -> Outcome {
    let dropped = |reason: &str| Outcome::Dropped {
        reason: reason.to_owned(),
    };
    let source = source_rule.map_or("direct", |s| s.id.as_str());
    let occurred_ms = env.date_ms.filter(|d| *d > 0).unwrap_or(fallback_ms);
    let mut confidence = rule.confidence;
    let authentic = env.outgoing || env.dkim_aligned(&pack.trusted_authserv);
    if !authentic && source != "direct" {
        confidence = confidence.min(pack.unauthenticated_confidence_cap);
    }
    let counterpart = if env.outgoing {
        env.to
            .first()
            .and_then(|(_, a)| a.rsplit('@').next())
            .map(str::to_owned)
    } else {
        Some(env.sender_domain.clone())
    };
    let sender_domain = counterpart.filter(|d| !d.is_empty() && d.len() <= 253);
    let event = |caps: Captures, link: Option<String>, confidence: u8, kind: TrackerEventKind| {
        TrackerEventInput {
            kind,
            company: caps.company.unwrap_or_else(|| UNKNOWN_COMPANY.to_owned()),
            role: caps.role,
            location: caps.location,
            source: source.to_owned(),
            link,
            occurred_ms,
            message_ref: Some(env.message_ref.clone()),
            sender_domain: sender_domain.clone(),
            evidence: Some(evidence(text, &rule.when)).filter(|e| !e.is_empty()),
            classifier: format!("rule:{}", rule.id),
            confidence,
            next_step: None,
            thread_refs: env.reply_refs.clone(),
            requires_thread,
        }
    };
    // An alert digest lists several jobs; other leads are one job each.
    let events: Vec<TrackerEventInput> =
        if rule.event == TrackerEventKind::JobAlert && rule.id.ends_with(".alert") {
            alert_items(pack, &text.body)
                .into_iter()
                .map(|(caps, link)| event(caps, link, confidence, TrackerEventKind::JobAlert))
                .collect()
        } else {
            let mut caps = extract(pack, text);
            if caps.company.is_none() {
                caps.company = source_rule.and_then(|s| s.name.clone());
            }
            if caps.company.is_none() {
                caps.company = if env.outgoing {
                    recipient_company(env, pack)
                } else {
                    display_name_company(env, pack)
                };
            }
            if caps.company.is_none() && !requires_thread {
                confidence = confidence.min(50);
            }
            // A lead without a role is not actionable (sales pitches, digests).
            if rule.event == TrackerEventKind::JobAlert && caps.role.is_none() {
                return dropped("lead_without_role");
            }
            vec![event(caps, posting_link(env, pack), confidence, rule.event)]
        };
    if events.is_empty() {
        return dropped("alert_without_items");
    }
    let events: Vec<TrackerEventInput> = events
        .into_iter()
        .filter(TrackerEventInput::is_valid)
        .collect();
    if events.is_empty() {
        return dropped("unextractable");
    }
    Outcome::Events {
        rule: rule.id.clone(),
        authentic,
        events,
    }
}
