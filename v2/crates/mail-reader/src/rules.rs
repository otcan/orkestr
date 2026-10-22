//! The job-mail rule pack: data shipped with a recipe
//! (`v2/recipes/job-tracker/rules.json`), not code. Senders, phrases and
//! extraction templates are edited there and unit-tested with synthetic mail.
use orkestr_v2_contracts::TrackerEventKind;
use serde::Deserialize;
use std::collections::BTreeSet;

pub const RULES_SCHEMA: &str = "orkestr.jobmail-rules.v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulePack {
    pub schema: String,
    pub version: String,
    /// Receiving servers whose `Authentication-Results` are trusted; empty
    /// trusts the topmost header from any server.
    #[serde(default)]
    pub trusted_authserv: Vec<String>,
    /// Confidence cap for ATS-family mail without aligned DKIM.
    pub unauthenticated_confidence_cap: u8,
    pub sources: Vec<SourceRule>,
    /// Display names that are vendors, never the employer.
    #[serde(default)]
    pub vendor_names: Vec<String>,
    /// Personal mail providers: outgoing mail to them is private unless it
    /// clearly is an application.
    #[serde(default)]
    pub freemail_domains: Vec<String>,
    /// Senders whose mail is never job evidence (marketing that slips past
    /// the bulk markers).
    #[serde(default)]
    pub deny_senders: Vec<String>,
    #[serde(default)]
    pub drop: Vec<DropRule>,
    /// Ordered: the first matching rule labels the message.
    pub rules: Vec<EventRule>,
    pub extract: Extract,
    #[serde(default)]
    pub alerts: AlertExtract,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRule {
    /// `linkedin`, `ats:greenhouse`, `assessment:hackerrank`, ...
    pub id: String,
    #[serde(default)]
    pub sender_domains: Vec<String>,
    /// Domains in body links that identify the source when the employer
    /// sends from its own domain.
    #[serde(default)]
    pub link_domains: Vec<String>,
    /// Drop the message unless DKIM aligns (spoofed senders).
    #[serde(default)]
    pub require_dkim: bool,
    /// Links on these domains are job postings (the row's link).
    #[serde(default)]
    pub posting_links: bool,
    /// Transactional system mail about one application (LinkedIn, ATS,
    /// assessment vendors): with aligned DKIM it may create and move rows
    /// on its own. Others (agencies, platforms) move rows only in a thread.
    #[serde(default)]
    pub trusted: bool,
    /// Display name used as the company (agencies: "Hays").
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Received mail (inbox).
    #[default]
    Incoming,
    /// The user's own sent mail.
    Outgoing,
}

/// When an event may create or move a row without a known thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gate {
    /// Always (the user's own applications, leads).
    None,
    /// From a trusted, authenticated source; otherwise only in a known thread.
    #[default]
    Trusted,
    /// Only as a reply in a known thread.
    Thread,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DropRule {
    pub id: String,
    pub when: Condition,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventRule {
    pub id: String,
    pub event: TrackerEventKind,
    pub confidence: u8,
    #[serde(default)]
    pub direction: Direction,
    #[serde(default)]
    pub gate: Gate,
    pub when: Condition,
}

/// Every present field must hold. Phrases are case-insensitive whole words;
/// a trailing `*` matches a word prefix (`bewerbung*`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    /// Sender local part starts with one of these.
    #[serde(default)]
    pub from_prefix: Vec<String>,
    /// Source id, `prefix:*`, or `known` (any source but `direct`).
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub not_sources: Vec<String>,
    /// At least one phrase in subject or body.
    #[serde(default)]
    pub any: Vec<String>,
    /// Each group needs one phrase (subject or body).
    #[serde(default)]
    pub all: Vec<Vec<String>>,
    /// No phrase may appear.
    #[serde(default)]
    pub none: Vec<String>,
    /// At least one phrase in the subject.
    #[serde(default)]
    pub subject_any: Vec<String>,
    /// Bulk/marketing markers present (or absent).
    #[serde(default)]
    pub bulk: Option<bool>,
    /// The message is a reply (has In-Reply-To or References).
    #[serde(default)]
    pub in_reply: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Extract {
    /// Templates with `{company}`, `{role}`, `{location}`; tried in order.
    pub subject: Vec<String>,
    pub body: Vec<String>,
    /// Words removed from a sender display name used as the company.
    #[serde(default)]
    pub display_name_noise: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlertExtract {
    /// One line per job in an alert; the next job link after it is its link.
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default = "alert_max")]
    pub max_items: usize,
}
fn alert_max() -> usize {
    25
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleError(pub String);
impl std::fmt::Display for RuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid rule pack: {}", self.0)
    }
}
impl std::error::Error for RuleError {}

impl Condition {
    fn is_empty(&self) -> bool {
        self.from_prefix.is_empty()
            && self.sources.is_empty()
            && self.any.is_empty()
            && self.all.is_empty()
            && self.subject_any.is_empty()
            && self.bulk.is_none()
            && self.in_reply.is_none()
    }
    fn normalize(&mut self) {
        let lower = |v: &mut Vec<String>| v.iter_mut().for_each(|s| *s = s.trim().to_lowercase());
        lower(&mut self.from_prefix);
        lower(&mut self.any);
        lower(&mut self.none);
        lower(&mut self.subject_any);
        self.all.iter_mut().for_each(lower);
    }
    fn phrases(&self) -> impl Iterator<Item = &String> {
        self.any
            .iter()
            .chain(&self.none)
            .chain(&self.subject_any)
            .chain(self.all.iter().flatten())
    }
}

impl RulePack {
    pub fn from_json(text: &str) -> Result<Self, RuleError> {
        let mut pack: RulePack =
            serde_json::from_str(text).map_err(|e| RuleError(e.to_string()))?;
        pack.normalize_and_validate()?;
        Ok(pack)
    }

    fn normalize_and_validate(&mut self) -> Result<(), RuleError> {
        let fail = |m: String| Err(RuleError(m));
        if self.schema != RULES_SCHEMA {
            return fail(format!("schema must be {RULES_SCHEMA}"));
        }
        if self.version.is_empty() || self.unauthenticated_confidence_cap > 100 {
            return fail("version and confidence cap".into());
        }
        let mut ids = BTreeSet::new();
        for source in &mut self.sources {
            source.sender_domains.iter_mut().for_each(|d| *d = d.to_ascii_lowercase());
            source.link_domains.iter_mut().for_each(|d| *d = d.to_ascii_lowercase());
            if source.id.is_empty() || source.id == "direct" || !ids.insert(format!("source:{}", source.id)) {
                return fail(format!("source id {:?}", source.id));
            }
        }
        for rule in &mut self.drop {
            rule.when.normalize();
            if rule.when.is_empty() || !ids.insert(format!("drop:{}", rule.id)) {
                return fail(format!("drop rule {:?}", rule.id));
            }
        }
        for rule in &mut self.rules {
            rule.when.normalize();
            if rule.when.is_empty()
                || rule.confidence > 100
                || rule.event == TrackerEventKind::Note
                || !ids.insert(format!("rule:{}", rule.id))
            {
                return fail(format!("rule {:?}", rule.id));
            }
        }
        let phrases_ok = self
            .drop
            .iter()
            .map(|r| &r.when)
            .chain(self.rules.iter().map(|r| &r.when))
            .flat_map(Condition::phrases)
            .all(|p| !p.is_empty() && p.len() <= 120);
        if !phrases_ok {
            return fail("empty or long phrase".into());
        }
        for template in self
            .extract
            .subject
            .iter()
            .chain(&self.extract.body)
            .chain(&self.alerts.items)
        {
            crate::template::Template::parse(template)
                .map_err(|e| RuleError(format!("template {template:?}: {e}")))?;
        }
        self.vendor_names.iter_mut().for_each(|v| *v = v.to_lowercase());
        self.freemail_domains.iter_mut().for_each(|v| *v = v.to_ascii_lowercase());
        self.deny_senders.iter_mut().for_each(|v| *v = v.to_ascii_lowercase());
        self.extract
            .display_name_noise
            .iter_mut()
            .for_each(|v| *v = v.to_lowercase());
        Ok(())
    }
}
