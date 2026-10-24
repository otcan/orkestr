//! Explicit recurring read-only automation decisions. No model instructions.
use crate::{tracker_actions::TrackerScanAuthority, CalendarRule};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerAutomationEnable {
    pub request_key: String,
    pub expected_revision: i64,
    pub expected_timer_revision: Option<i64>,
    pub expected_source_revision: i64,
    pub expected_recipe: String,
    pub expected_classifier_id: String,
    pub expected_classifier_digest: String,
    pub calendar: CalendarRule,
    pub acknowledge_automation: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerAutomationDisable {
    pub request_key: String,
    pub expected_revision: i64,
    pub expected_timer_revision: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerAutomationReceipt {
    pub request_key: String,
    pub revision: i64,
    pub enabled: bool,
    pub authority: Option<TrackerScanAuthority>,
    pub duplicate: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerAutomationStatus {
    pub revision: i64,
    pub enabled: bool,
    pub source_current: bool,
    pub timer_revision: Option<i64>,
    pub authority: Option<TrackerScanAuthority>,
    pub calendar: Option<CalendarRule>,
}
