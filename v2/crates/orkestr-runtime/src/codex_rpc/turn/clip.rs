//! A reply over the progress bound is cut, never refused. Core stores at most
//! `MAX_PROVIDER_PROGRESS_BYTES` of one progress payload; refusing a longer
//! agent message poisoned the turn, so the run was cancelled and the owner
//! received nothing at all.

/// Ends a reply cut at the progress bound. The provider broker appends the
/// same text to a cut Claude reply (`provider-broker/protocol.py`).
pub const CLIPPED_NOTE: &str =
    "\n\n(Reply cut at the 8 KB message limit; the rest was not delivered. Ask for it as a file.)";

/// The longest prefix of `text` within `max` bytes that ends on a character
/// boundary. The broker cuts a completed agent message the same way
/// (`protocol.py` `clip_utf8`), so a text built from deltas agrees with it.
pub(super) fn clip(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `text` as delivered within `budget` bytes: unchanged when it fits and was
/// not cut upstream, otherwise its bounded prefix followed by `CLIPPED_NOTE`.
pub(super) fn fit(text: &str, budget: usize, clipped: bool) -> String {
    debug_assert!(budget >= CLIPPED_NOTE.len());
    if !clipped && text.len() <= budget {
        return text.to_owned();
    }
    let room = budget.saturating_sub(CLIPPED_NOTE.len());
    format!("{}{CLIPPED_NOTE}", clip(text, room))
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES as MAX;

    #[test]
    fn clip_keeps_whole_characters_and_the_longest_prefix() {
        let text = "aşğ🦀ı";
        for max in 0..=text.len() {
            let kept = clip(text, max);
            assert!(kept.len() <= max);
            assert!(text.starts_with(kept));
            // No longer prefix ending on a character boundary fits.
            assert!((kept.len() + 1..=max).all(|end| !text.is_char_boundary(end)));
        }
        assert_eq!(clip("aş", 2), "a");
        assert_eq!(clip("aş", 3), "aş");
    }

    #[test]
    fn fit_marks_only_a_cut_reply_and_stays_within_the_bound() {
        assert_eq!(fit("short", MAX, false), "short");
        let exact = "x".repeat(MAX);
        assert_eq!(fit(&exact, MAX, false), exact);
        for (text, clipped) in [("ş".repeat(MAX), false), ("x".repeat(MAX), true)] {
            let delivered = fit(&text, MAX, clipped);
            assert!(delivered.len() <= MAX);
            assert!(delivered.ends_with(CLIPPED_NOTE));
            assert!(text.starts_with(delivered.trim_end_matches(CLIPPED_NOTE)));
        }
    }
}
