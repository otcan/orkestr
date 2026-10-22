//! Recipes embedded at build time from `v2/recipes/<id>/`: data files (a
//! manifest, run instructions, a mail rule pack), never code. Parsed and
//! validated once; a malformed shipped recipe fails the unit tests.
use orkestr_v2_contracts::{CalendarRule, RecipeSummary, RecipeTimerSummary, TrackerEventKind};
use orkestr_v2_mail_reader::RulePack;
use serde::Deserialize;
use std::sync::OnceLock;

pub(crate) const RECIPE_SCHEMA: &str = "orkestr.recipe.v1";

/// (id, manifest, files) of every shipped recipe.
const SHIPPED: &[(&str, &str, &[(&str, &str)])] = &[(
    "job-tracker",
    include_str!("../../../recipes/job-tracker/recipe.json"),
    &[
        ("instructions.md", include_str!("../../../recipes/job-tracker/instructions.md")),
        ("rules.json", include_str!("../../../recipes/job-tracker/rules.json")),
    ],
)];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub title: String,
    pub summary: String,
    pub conversation: ConversationPart,
    #[serde(default)]
    pub tracker: Option<TrackerPart>,
    #[serde(default)]
    pub mail: Option<MailPart>,
    #[serde(default)]
    pub timers: Vec<TimerPart>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConversationPart {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrackerPart {
    pub notify_on: Vec<TrackerEventKind>,
    pub rules: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MailPart {
    pub kind: String,
    #[serde(default)]
    pub folders: Vec<String>,
    pub since_days: u32,
    pub max_messages_per_scan: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TimerPart {
    pub id: String,
    pub label: String,
    pub schedule: SchedulePart,
    #[serde(default)]
    pub silent_mode: Option<String>,
    pub instructions: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SchedulePart {
    #[serde(default)]
    pub weekdays: Vec<u8>,
    pub start_minute: u16,
    pub end_minute: u16,
    #[serde(default = "one")]
    pub every_hours: u8,
    pub minutes: Vec<u8>,
}
fn one() -> u8 {
    1
}

impl SchedulePart {
    pub(crate) fn rule(&self, timezone: &str) -> Result<CalendarRule, &'static str> {
        CalendarRule {
            timezone: timezone.to_owned(),
            weekdays: self.weekdays.clone(),
            start_minute: self.start_minute,
            end_minute: self.end_minute,
            every_hours: self.every_hours,
            minutes: self.minutes.clone(),
        }
        .normalized()
    }
}

pub(crate) struct Recipe {
    pub manifest: Manifest,
    files: Vec<(&'static str, &'static str)>,
    pub rules: Option<RulePack>,
}

impl Recipe {
    pub(crate) fn file(&self, name: &str) -> Option<&'static str> {
        self.files.iter().find(|(n, _)| *n == name).map(|(_, text)| *text)
    }
    /// A timer's instructions with `{conversation_id}` and `{origin}` filled in.
    pub(crate) fn instructions(&self, timer: &TimerPart, conversation: &str, origin: &str) -> Option<String> {
        Some(
            self.file(&timer.instructions)?
                .replace("{conversation_id}", conversation)
                .replace("{origin}", origin.trim_end_matches('/')),
        )
    }
    pub(crate) fn summary(&self) -> RecipeSummary {
        let m = &self.manifest;
        RecipeSummary {
            id: m.id.clone(),
            version: m.version.clone(),
            title: m.title.clone(),
            summary: m.summary.clone(),
            conversation_name: m.conversation.name.clone(),
            timers: m
                .timers
                .iter()
                .map(|t| RecipeTimerSummary {
                    label: t.label.clone(),
                    schedule: t.schedule.rule("UTC").map(|r| r.describe()).unwrap_or_default(),
                    silent_unless_changed: t.silent_mode.as_deref() == Some("unless_changed"),
                })
                .collect(),
            mail: m.mail.as_ref().map(|mail| mail.kind.clone()),
        }
    }
}

fn parse(id: &str, manifest: &str, files: &[(&'static str, &'static str)]) -> Result<Recipe, String> {
    let manifest: Manifest = serde_json::from_str(manifest).map_err(|e| format!("{id}: {e}"))?;
    let token = |v: &str| !v.is_empty() && v.len() <= 80 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    if manifest.schema != RECIPE_SCHEMA || manifest.id != id || !token(&manifest.id) {
        return Err(format!("{id}: schema or id"));
    }
    if manifest.conversation.name.trim().is_empty() || manifest.conversation.name.chars().count() > 120 {
        return Err(format!("{id}: conversation name"));
    }
    let recipe = Recipe { manifest, files: files.to_vec(), rules: None };
    let rules = match recipe.manifest.tracker.as_ref().and_then(|t| t.rules.as_deref()) {
        Some(name) => {
            let text = recipe.file(name).ok_or(format!("{id}: missing {name}"))?;
            Some(RulePack::from_json(text).map_err(|e| format!("{id}: {e}"))?)
        }
        None => None,
    };
    if let Some(mail) = &recipe.manifest.mail {
        if mail.kind != "thunderbird" || mail.since_days == 0 || mail.since_days > 365 || !(1..=5000).contains(&mail.max_messages_per_scan) {
            return Err(format!("{id}: mail"));
        }
    }
    for timer in &recipe.manifest.timers {
        timer.schedule.rule("UTC").map_err(|e| format!("{id}: {e}"))?;
        if !token(&timer.id)
            || timer.label.trim().is_empty()
            || recipe.file(&timer.instructions).is_none()
            || !matches!(timer.silent_mode.as_deref(), None | Some("off") | Some("unless_changed"))
        {
            return Err(format!("{id}: timer {}", timer.id));
        }
    }
    Ok(Recipe { rules, ..recipe })
}

/// Every shipped recipe (parsed once; invalid ones are left out and logged).
pub(crate) fn catalog() -> &'static [Recipe] {
    static CATALOG: OnceLock<Vec<Recipe>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        SHIPPED
            .iter()
            .filter_map(|(id, manifest, files)| match parse(id, manifest, files) {
                Ok(recipe) => Some(recipe),
                Err(error) => {
                    eprintln!("orkestr-v2: recipe refused: {error}");
                    None
                }
            })
            .collect()
    })
}

pub(crate) fn find(id: &str) -> Option<&'static Recipe> {
    catalog().iter().find(|r| r.manifest.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_recipe_parses() {
        assert_eq!(catalog().len(), SHIPPED.len());
        let jobs = find("job-tracker").unwrap();
        assert!(jobs.rules.is_some());
        let summary = jobs.summary();
        assert_eq!(summary.timers.len(), 1);
        assert!(summary.timers[0].silent_unless_changed);
        assert_eq!(summary.mail.as_deref(), Some("thunderbird"));
        let rule = jobs.manifest.timers[0].schedule.rule("Europe/Berlin").unwrap();
        assert_eq!(rule.times_per_day(), 12, "hourly 09:00-20:00");
        assert!((1..=5).all(|d| rule.runs_on(d)) && !rule.runs_on(6) && !rule.runs_on(7));
        let text = jobs
            .instructions(&jobs.manifest.timers[0], "11111111-2222-4333-8444-555555555555", "http://127.0.0.1:47110/")
            .unwrap();
        assert!(text.contains("http://127.0.0.1:47110/api/v2/conversations/11111111-2222-4333-8444-555555555555/tracker/mail-scan"));
        assert!(text.contains("NO_NEWS"));
        assert!(!text.contains('{') || !text.contains("{origin}"));
    }

    #[test]
    fn malformed_recipes_are_refused() {
        let good = SHIPPED[0];
        let mut value: serde_json::Value = serde_json::from_str(good.1).unwrap();
        value["schema"] = "other".into();
        assert!(parse(good.0, &value.to_string(), good.2).is_err());
        let mut value: serde_json::Value = serde_json::from_str(good.1).unwrap();
        value["timers"][0]["schedule"]["start_minute"] = 2000.into();
        assert!(parse(good.0, &value.to_string(), good.2).is_err());
        let mut value: serde_json::Value = serde_json::from_str(good.1).unwrap();
        value["timers"][0]["instructions"] = "missing.md".into();
        assert!(parse(good.0, &value.to_string(), good.2).is_err());
        assert!(parse("other-id", good.1, good.2).is_err());
    }
}
