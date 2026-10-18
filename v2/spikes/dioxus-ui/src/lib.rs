//! Bounded, synthetic client projection. Not the M1 API, a store or authority.
use std::collections::VecDeque;

pub const WINDOW: usize = 50;
pub const MAX_TEXT_BYTES: usize = 8_192;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixtureEvent {
    pub sequence: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Apply {
    Applied,
    Duplicate,
    ResyncRequired,
    Invalid,
}

#[derive(Clone, Debug, Default)]
pub struct ClientView {
    cursor: u64,
    visible: VecDeque<FixtureEvent>,
    pub draft: String,
    pub connected: bool,
    pub resync_required: bool,
}

impl ClientView {
    pub fn connected_fixture() -> Self {
        Self {
            connected: true,
            ..Self::default()
        }
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn visible(&self) -> &VecDeque<FixtureEvent> {
        &self.visible
    }

    /// Mirrors cursor semantics only; actor/scope authentication is server-owned.
    pub fn apply(&mut self, event: FixtureEvent) -> Apply {
        if event.sequence == 0 || event.text.len() > MAX_TEXT_BYTES {
            return Apply::Invalid;
        }
        if event.sequence <= self.cursor {
            // Old data outside the bounded window cannot be verified locally.
            return match self.visible.iter().find(|e| e.sequence == event.sequence) {
                Some(previous) if previous == &event => Apply::Duplicate,
                _ => {
                    self.resync_required = true;
                    Apply::ResyncRequired
                }
            };
        }
        if self.resync_required || self.cursor.checked_add(1) != Some(event.sequence) {
            self.resync_required = true;
            return Apply::ResyncRequired;
        }
        self.cursor = event.sequence;
        self.visible.push_back(event);
        if self.visible.len() > WINDOW {
            self.visible.pop_front();
        }
        Apply::Applied
    }

    /// Accept a bounded, contiguous snapshot ending at its declared watermark.
    /// Preserve draft; never silently overwrite the cursor with stale evidence.
    pub fn snapshot(&mut self, cursor: u64, events: Vec<FixtureEvent>) -> Apply {
        if cursor < self.cursor || events.len() > WINDOW {
            return Apply::Invalid;
        }
        let valid = if cursor == 0 {
            events.is_empty()
        } else {
            !events.is_empty()
                && events.last().is_some_and(|event| event.sequence == cursor)
                && events
                    .iter()
                    .all(|e| e.sequence > 0 && e.text.len() <= MAX_TEXT_BYTES)
                && events
                    .windows(2)
                    .all(|pair| pair[0].sequence.checked_add(1) == Some(pair[1].sequence))
        };
        if !valid {
            return Apply::Invalid;
        }
        self.visible = events.into();
        self.cursor = cursor;
        self.resync_required = false;
        Apply::Applied
    }
}

pub fn fixture_event(sequence: u64) -> FixtureEvent {
    FixtureEvent {
        sequence,
        text: format!("Synthetic progress batch {sequence}; no provider or external action."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_survives_stream_and_snapshot() {
        let mut view = ClientView {
            draft: "Türkçe 日本語 👋".into(),
            ..Default::default()
        };
        assert_eq!(view.apply(fixture_event(1)), Apply::Applied);
        assert_eq!(
            view.snapshot(2, vec![fixture_event(1), fixture_event(2)]),
            Apply::Applied
        );
        assert_eq!(view.draft, "Türkçe 日本語 👋");
    }

    #[test]
    fn duplicate_is_not_rendered_twice_and_changed_replay_resyncs() {
        let mut view = ClientView::default();
        view.apply(fixture_event(1));
        assert_eq!(view.apply(fixture_event(1)), Apply::Duplicate);
        assert_eq!(view.visible().len(), 1);
        assert_eq!(
            view.apply(FixtureEvent {
                sequence: 1,
                text: "changed".into()
            }),
            Apply::ResyncRequired
        );
        assert_eq!(view.cursor(), 1);
    }

    #[test]
    fn reconnect_replays_from_cursor_and_gap_requires_snapshot() {
        let mut view = ClientView::default();
        view.apply(fixture_event(1));
        view.connected = false;
        view.connected = true;
        assert_eq!(view.apply(fixture_event(2)), Apply::Applied);
        assert_eq!(view.apply(fixture_event(4)), Apply::ResyncRequired);
        assert_eq!(view.apply(fixture_event(3)), Apply::ResyncRequired);
        assert_eq!(view.cursor(), 2);
        assert_eq!(
            view.snapshot(4, (1..=4).map(fixture_event).collect()),
            Apply::Applied
        );
        assert_eq!(view.apply(fixture_event(5)), Apply::Applied);
    }

    #[test]
    fn ten_thousand_events_retain_only_window() {
        let mut view = ClientView::default();
        for sequence in 1..=10_000 {
            assert_eq!(view.apply(fixture_event(sequence)), Apply::Applied);
        }
        assert_eq!(view.visible().len(), WINDOW);
        assert_eq!(view.visible().front().unwrap().sequence, 9_951);
        assert_eq!(view.cursor(), 10_000);
        assert_eq!(view.apply(fixture_event(1)), Apply::ResyncRequired);
    }

    #[test]
    fn stale_gapped_or_oversized_snapshot_leaves_state_intact() {
        let mut view = ClientView::default();
        view.apply(fixture_event(1));
        assert_eq!(view.snapshot(0, vec![]), Apply::Invalid);
        assert_eq!(
            view.snapshot(3, vec![fixture_event(1), fixture_event(3)]),
            Apply::Invalid
        );
        assert_eq!(
            view.snapshot(51, (1..=51).map(fixture_event).collect()),
            Apply::Invalid
        );
        assert_eq!(view.cursor(), 1);
        assert_eq!(view.visible().len(), 1);
    }

    #[test]
    fn invalid_event_does_not_advance_cursor() {
        let mut view = ClientView::default();
        assert_eq!(view.apply(fixture_event(0)), Apply::Invalid);
        assert_eq!(
            view.apply(FixtureEvent {
                sequence: 1,
                text: "x".repeat(MAX_TEXT_BYTES + 1)
            }),
            Apply::Invalid
        );
        assert_eq!(view.cursor(), 0);
    }
}
