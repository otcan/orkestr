//! How a timer run's final answer is treated when the timer is "silent unless
//! changed". The marker is the first line of the answer, so a run that really has
//! news is never swallowed by a marker buried in its body.
use crate::conversation_settings::is_no_reply;

pub const SUMMARY_LIMIT: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerResult {
    /// Send the answer as usual.
    Deliver,
    /// Send nothing. `NO_REPLY` or a "no news" marker; the summary feeds the digest.
    Silent { summary: String },
    /// Worth a line in the digest, not worth a message of its own.
    LowSignal { summary: String },
}

fn marker(line: &str, names: &[&str]) -> Option<String> {
    let line = line
        .trim()
        .trim_start_matches(['[', '*', '_', '`', '#', ' '])
        .trim_end_matches([']', '*', '`']);
    for name in names {
        if line.len() >= name.len()
            && line.is_char_boundary(name.len())
            && line[..name.len()].eq_ignore_ascii_case(name)
        {
            let rest = line[name.len()..].trim_start_matches([']', '*', '_', '`', ' ']);
            if rest.is_empty() {
                return Some(String::new());
            }
            if let Some(rest) = rest
                .strip_prefix(':')
                .or_else(|| rest.strip_prefix('-'))
                .or_else(|| rest.strip_prefix('—'))
                .or_else(|| rest.strip_prefix('–'))
            {
                return Some(rest.trim().to_owned());
            }
        }
    }
    None
}

fn summary(first: String, rest: &str, fallback: &str) -> String {
    let mut text = first;
    if text.is_empty() {
        text = rest.trim().replace('\n', " ");
    }
    if text.is_empty() {
        text = fallback.to_owned();
    }
    if text.chars().count() > SUMMARY_LIMIT {
        text = text.chars().take(SUMMARY_LIMIT).collect::<String>() + "…";
    }
    text
}

/// `silent_unless_changed` enables the `NO_NEWS` / `LOW_SIGNAL` markers. An exact
/// `NO_REPLY` is silent either way, as for every other conversation.
pub fn classify_timer_result(text: &str, silent_unless_changed: bool) -> TimerResult {
    if text.trim().is_empty() || is_no_reply(text) {
        return TimerResult::Silent {
            summary: "no reply".into(),
        };
    }
    if !silent_unless_changed {
        return TimerResult::Deliver;
    }
    let trimmed = text.trim_start();
    let (first, rest) = trimmed.split_once('\n').unwrap_or((trimmed, ""));
    if let Some(head) = marker(first, &["NO_NEWS", "NO NEWS", "NO-NEWS"]) {
        return TimerResult::Silent {
            summary: summary(head, rest, "no news"),
        };
    }
    if let Some(head) = marker(first, &["LOW_SIGNAL", "LOW SIGNAL", "LOW-SIGNAL"]) {
        return TimerResult::LowSignal {
            summary: summary(head, rest, "low signal"),
        };
    }
    TimerResult::Deliver
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silent(text: &str) -> Option<String> {
        match classify_timer_result(text, true) {
            TimerResult::Silent { summary } => Some(summary),
            _ => None,
        }
    }

    #[test]
    fn no_reply_is_silent_with_or_without_the_policy() {
        for on in [false, true] {
            assert!(matches!(
                classify_timer_result("  NO_REPLY\n", on),
                TimerResult::Silent { .. }
            ));
        }
        assert_eq!(
            classify_timer_result("no_reply", false),
            TimerResult::Deliver
        );
        assert!(matches!(
            classify_timer_result("   ", false),
            TimerResult::Silent { .. }
        ));
    }

    #[test]
    fn no_news_markers_need_the_policy_and_the_first_line() {
        assert_eq!(silent("NO_NEWS").as_deref(), Some("no news"));
        assert_eq!(
            silent("no news: inbox unchanged").as_deref(),
            Some("inbox unchanged")
        );
        assert_eq!(
            silent("**NO NEWS** - 0 new mails").as_deref(),
            Some("0 new mails")
        );
        assert_eq!(
            silent("[NO_NEWS]\n3 newsletters ignored").as_deref(),
            Some("3 newsletters ignored")
        );
        assert_eq!(
            classify_timer_result("NO_NEWS", false),
            TimerResult::Deliver
        );
        // A marker later in the body never hides real news.
        assert_eq!(
            classify_timer_result("New offer from X\nNO_NEWS elsewhere", true),
            TimerResult::Deliver
        );
        // A word that merely starts like the marker is ordinary text.
        assert_eq!(
            classify_timer_result("NO_NEWSLETTER arrived", true),
            TimerResult::Deliver
        );
    }

    #[test]
    fn low_signal_goes_to_the_digest_and_summaries_are_bounded() {
        assert_eq!(
            classify_timer_result("LOW_SIGNAL: two promo mails", true),
            TimerResult::LowSignal {
                summary: "two promo mails".into()
            }
        );
        let long = format!("NO_NEWS: {}", "x".repeat(500));
        assert_eq!(silent(&long).unwrap().chars().count(), SUMMARY_LIMIT + 1);
    }
}
