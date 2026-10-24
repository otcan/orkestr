//! Pure setup forms. Neither folder discovery nor reading starts from a render.
use orkestr_v2_contracts::{tracker_actions::*, tracker_automation::*, CalendarRule};

#[derive(Clone, Default, PartialEq)]
pub struct SourceForm {
    pub source_id: Option<String>,
    pub inbox: Vec<String>,
    pub sent: Vec<String>,
    pub acknowledged: bool,
}
impl SourceForm {
    pub fn choose(&mut self, source: String) {
        self.source_id = Some(source);
        self.inbox.clear();
        self.sent.clear();
        self.acknowledged = false;
    }
    pub fn toggle(&mut self, folder: String, outgoing: bool) {
        let selected = if outgoing {
            &mut self.sent
        } else {
            &mut self.inbox
        };
        if selected.contains(&folder) {
            selected.retain(|id| id != &folder);
        } else {
            selected.push(folder);
        }
        self.acknowledged = false;
    }
    pub fn selection(&self, key: &str, revision: i64) -> Result<TrackerSourceSelect, &'static str> {
        let source: SelectedMailSource = serde_json::from_value(serde_json::json!({
            "source_id":self.source_id.as_ref().ok_or("Choose a mail profile.")?, "inbox":self.inbox, "sent":self.sent,
        })).map_err(|_| "Choose valid mail folders.")?;
        if !source.is_valid() {
            return Err("Choose both Inbox and Sent folders (up to eight total).");
        }
        if !self.acknowledged {
            return Err("Confirm local synchronization and read-only access.");
        }
        Ok(TrackerSourceSelect {
            request_key: key.into(),
            expected_revision: revision,
            source,
            acknowledge_read_only_access: true,
        })
    }
}

#[derive(Clone, PartialEq)]
pub struct AutomationForm {
    pub timezone: String,
    pub time: String,
    pub weekdays: Vec<u8>,
    pub acknowledged: bool,
    pub frequent: bool,
}
impl Default for AutomationForm {
    fn default() -> Self {
        Self {
            timezone: String::new(),
            time: "09:00".into(),
            weekdays: vec![1, 2, 3, 4, 5],
            acknowledged: false,
            frequent: false,
        }
    }
}
impl AutomationForm {
    pub fn from_status(status: &TrackerAutomationStatus) -> Self {
        let Some(rule) = &status.calendar else {
            return Self::default();
        };
        let at = rule.day_minutes().first().copied().unwrap_or(540);
        Self {
            timezone: rule.timezone.clone(),
            time: format!("{:02}:{:02}", at / 60, at % 60),
            weekdays: if rule.weekdays.is_empty() {
                (1..=7).collect()
            } else {
                rule.weekdays.clone()
            },
            acknowledged: false,
            frequent: rule.start_minute == 0
                && rule.end_minute == 1439
                && rule.every_hours == 1
                && rule.minutes == [0, 15, 30, 45],
        }
    }
    pub fn calendar(&self) -> Result<CalendarRule, &'static str> {
        if self.weekdays.is_empty() {
            return Err("Choose at least one day.");
        }
        if self.frequent {
            return CalendarRule {
                timezone: self.timezone.trim().into(),
                weekdays: self.weekdays.clone(),
                start_minute: 0,
                end_minute: 1439,
                every_hours: 1,
                minutes: vec![0, 15, 30, 45],
            }
            .normalized();
        }
        let (hour, minute) = self.time.split_once(':').ok_or("Choose a time.")?;
        let hour: u16 = hour.parse().map_err(|_| "Choose a time.")?;
        let minute: u16 = minute.parse().map_err(|_| "Choose a time.")?;
        if hour >= 24 || minute >= 60 {
            return Err("Choose a time.");
        }
        let at = hour * 60 + minute;
        CalendarRule {
            timezone: self.timezone.trim().into(),
            weekdays: self.weekdays.clone(),
            start_minute: at,
            end_minute: at,
            every_hours: 1,
            minutes: vec![minute as u8],
        }
        .normalized()
    }
    pub fn enable(
        &self,
        key: &str,
        before: &TrackerAutomationStatus,
        source_revision: i64,
        classifier: (&str, &str),
    ) -> Result<TrackerAutomationEnable, &'static str> {
        if !self.acknowledged {
            return Err("Choose whether to enable recurring checks.");
        }
        Ok(TrackerAutomationEnable {
            request_key: key.into(),
            expected_revision: before.revision,
            expected_timer_revision: before.timer_revision,
            expected_source_revision: source_revision,
            expected_recipe: "job-tracker".into(),
            expected_classifier_id: classifier.0.into(),
            expected_classifier_digest: classifier.1.into(),
            calendar: self.calendar()?,
            acknowledge_automation: true,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PendingDecision {
    pub kind: String,
    pub body: serde_json::Value,
}
impl PendingDecision {
    pub fn resolved(&self, status: u16, body: &serde_json::Value) -> bool {
        if status == 400 || status == 409 {
            return true;
        }
        status == 200
            && body.get("request_key").and_then(serde_json::Value::as_str) == self.key()
            && (self.kind != "check" || body["cancelled"] == true || !body["result"].is_null())
    }
    pub fn key(&self) -> Option<&str> {
        self.body.get("request_key")?.as_str()
    }
    pub fn operation(&self) -> Option<(&'static str, &'static str)> {
        match self.kind.as_str() {
            "selection" => Some(("PUT", "/mail-source")),
            "source_remove" => Some(("DELETE", "/mail-source")),
            "check" => Some(("POST", "/check")),
            "automation_enable" => Some(("POST", "/automation")),
            "automation_disable" => Some(("DELETE", "/automation")),
            _ => None,
        }
    }
    pub fn receipt_path(&self) -> Option<String> {
        let key = self.key()?;
        match self.kind.as_str() {
            "selection" | "source_remove" => Some(format!("/mail-source/decisions/{key}")),
            "check" => Some(format!("/checks/{key}")),
            "automation_enable" | "automation_disable" => {
                Some(format!("/automation/decisions/{key}"))
            }
            _ => None,
        }
    }
}
