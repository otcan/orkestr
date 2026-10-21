//! Calendar schedule rule shared by the store, the HTTP API and the UI.
//!
//! An RRULE-like subset: a time zone, optional weekdays, an hour window and
//! minute offsets. The pure shape and the plain-words description live here;
//! time-zone arithmetic (DST) is done by the store with the bundled tz database.
use serde::{Deserialize, Serialize};

pub const WEEKDAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

fn one() -> u8 {
    1
}

/// Fires at `minutes` past every `every_hours`-th hour counted from the window
/// start, on the listed weekdays (1 = Monday .. 7 = Sunday, empty = every day),
/// local to `timezone`. A run is inside the window when
/// `start_minute <= local minute of day <= end_minute` (both ends inclusive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarRule {
    pub timezone: String,
    #[serde(default)]
    pub weekdays: Vec<u8>,
    pub start_minute: u16,
    pub end_minute: u16,
    #[serde(default = "one")]
    pub every_hours: u8,
    pub minutes: Vec<u8>,
}

impl CalendarRule {
    /// Sorted, de-duplicated and range-checked. A full week is stored as "every day".
    pub fn normalized(mut self) -> Result<Self, &'static str> {
        self.weekdays.sort_unstable();
        self.weekdays.dedup();
        self.minutes.sort_unstable();
        self.minutes.dedup();
        if self.weekdays.iter().any(|d| !(1..=7).contains(d)) {
            return Err("weekday must be 1 (Monday) to 7 (Sunday)");
        }
        if self.weekdays.len() == 7 {
            self.weekdays.clear();
        }
        if self.minutes.is_empty() || self.minutes.iter().any(|m| *m >= 60) {
            return Err("minute offsets must be 0 to 59 and not empty");
        }
        if self.start_minute > self.end_minute || self.end_minute >= 1440 {
            return Err("the hour window must satisfy start <= end < 24:00");
        }
        if !(1..=24).contains(&self.every_hours) {
            return Err("every_hours must be 1 to 24");
        }
        if self.timezone.is_empty() || self.timezone.len() > 64 {
            return Err("a time zone is required");
        }
        if self.times_per_day() == 0 {
            return Err("the rule never fires inside its window");
        }
        Ok(self)
    }

    /// Local minutes of the day at which the rule fires, ascending.
    pub fn day_minutes(&self) -> Vec<u16> {
        let first_hour = self.start_minute / 60;
        let mut out = Vec::new();
        for hour in (first_hour..24).step_by(usize::from(self.every_hours.max(1))) {
            for minute in &self.minutes {
                let t = hour * 60 + u16::from(*minute);
                if t >= self.start_minute && t <= self.end_minute {
                    out.push(t);
                }
            }
        }
        out
    }

    pub fn times_per_day(&self) -> usize {
        self.day_minutes().len()
    }

    pub fn runs_on(&self, weekday_monday_one: u8) -> bool {
        self.weekdays.is_empty() || self.weekdays.contains(&weekday_monday_one)
    }

    /// "Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin".
    pub fn describe(&self) -> String {
        let offsets = self
            .minutes
            .iter()
            .map(|m| format!(":{m:02}"))
            .collect::<Vec<_>>();
        let offsets = match offsets.as_slice() {
            [] => String::new(),
            [only] => only.clone(),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        };
        let clock = |m: u16| format!("{:02}:{:02}", m / 60, m % 60);
        let days = self.describe_days();
        let times = self.day_minutes();
        if let [only] = times.as_slice() {
            return if self.weekdays.is_empty() {
                format!("Every day at {} {}", clock(*only), self.timezone)
            } else {
                format!("At {} {}, {days}", clock(*only), self.timezone)
            };
        }
        let cadence = match self.every_hours {
            1 => "Hourly".to_owned(),
            n => format!("Every {n} hours"),
        };
        format!(
            "{cadence} at {offsets}, {days}, {}–{} {}",
            clock(self.start_minute),
            clock(self.end_minute),
            self.timezone
        )
    }

    fn describe_days(&self) -> String {
        if self.weekdays.is_empty() {
            return "every day".into();
        }
        let mut parts = Vec::new();
        let mut i = 0;
        while i < self.weekdays.len() {
            let mut j = i;
            while j + 1 < self.weekdays.len() && self.weekdays[j + 1] == self.weekdays[j] + 1 {
                j += 1;
            }
            let name = |d: u8| WEEKDAY_NAMES[usize::from(d.clamp(1, 7) - 1)];
            parts.push(match j - i {
                0 => name(self.weekdays[i]).to_owned(),
                1 => format!("{}, {}", name(self.weekdays[i]), name(self.weekdays[j])),
                _ => format!("{}–{}", name(self.weekdays[i]), name(self.weekdays[j])),
            });
            i = j + 1;
        }
        parts.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(tz: &str, days: &[u8], start: u16, end: u16, minutes: &[u8]) -> CalendarRule {
        CalendarRule {
            timezone: tz.into(),
            weekdays: days.to_vec(),
            start_minute: start,
            end_minute: end,
            every_hours: 1,
            minutes: minutes.to_vec(),
        }
        .normalized()
        .unwrap()
    }

    #[test]
    fn berlin_workday_triage_reads_in_plain_words() {
        let r = rule("Europe/Berlin", &[1, 2, 3, 4, 5], 480, 1140, &[0]);
        assert_eq!(
            r.describe(),
            "Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin"
        );
        assert_eq!(r.times_per_day(), 12);
    }

    #[test]
    fn istanbul_evening_window_excludes_the_late_offset() {
        let r = rule("Europe/Istanbul", &[], 540, 1380, &[37]);
        assert_eq!(
            r.describe(),
            "Hourly at :37, every day, 09:00–23:00 Europe/Istanbul"
        );
        let times = r.day_minutes();
        assert_eq!(times.first(), Some(&(9 * 60 + 37)));
        assert_eq!(times.last(), Some(&(22 * 60 + 37)));
        assert_eq!(times.len(), 14);
    }

    #[test]
    fn single_daily_time_and_odd_weekdays() {
        let r = rule("UTC", &[], 540, 540, &[0]);
        assert_eq!(r.describe(), "Every day at 09:00 UTC");
        let r = rule("UTC", &[1, 3, 5, 6], 540, 570, &[30]);
        assert_eq!(r.describe(), "At 09:30 UTC, Mon, Wed, Fri, Sat");
        let r = rule("UTC", &[1, 2, 3, 4, 5, 6, 7], 0, 1439, &[0, 30]);
        assert!(r.weekdays.is_empty());
        assert_eq!(
            r.describe(),
            "Hourly at :00 and :30, every day, 00:00–23:59 UTC"
        );
    }

    #[test]
    fn step_hours_count_from_the_window_start() {
        let mut r = rule("UTC", &[], 8 * 60, 18 * 60, &[0]);
        r.every_hours = 3;
        assert_eq!(r.day_minutes(), vec![480, 660, 840, 1020]);
        assert_eq!(
            r.describe(),
            "Every 3 hours at :00, every day, 08:00–18:00 UTC"
        );
    }

    #[test]
    fn invalid_rules_are_refused() {
        let base = rule("UTC", &[], 0, 100, &[0]);
        for bad in [
            CalendarRule {
                weekdays: vec![0],
                ..base.clone()
            },
            CalendarRule {
                weekdays: vec![8],
                ..base.clone()
            },
            CalendarRule {
                minutes: vec![],
                ..base.clone()
            },
            CalendarRule {
                minutes: vec![60],
                ..base.clone()
            },
            CalendarRule {
                start_minute: 200,
                ..base.clone()
            },
            CalendarRule {
                end_minute: 1440,
                ..base.clone()
            },
            CalendarRule {
                every_hours: 0,
                ..base.clone()
            },
            CalendarRule {
                every_hours: 25,
                ..base.clone()
            },
            CalendarRule {
                timezone: String::new(),
                ..base.clone()
            },
            // :59 does not fit before an 08:30 window end.
            CalendarRule {
                start_minute: 480,
                end_minute: 510,
                minutes: vec![59],
                ..base.clone()
            },
        ] {
            assert!(bad.normalized().is_err());
        }
    }
}
