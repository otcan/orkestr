//! Interim updates in the web chat (owner decision 2026-11-18: "show every
//! message"). Each progress payload of a Deep run is its own message at its
//! event, marked Update, like WhatsApp; the run's accepted answer is the
//! accepted reply, marked Final, and is never shown twice. Pure: paths, page
//! checks, the kept window and what is shown.
use orkestr_v2_contracts::{AcceptedResult, EventId, RunUpdate, RunUpdates, RUN_UPDATES_PAGE_MAX};
use std::collections::{BTreeMap, BTreeSet};

/// Updates the chat keeps (newest first wins), about the inline reply window.
pub const UPDATES_KEPT: usize = 400;
/// Newest-first pages read when a chat opens (100 updates each).
pub const NEWEST_UPDATE_PAGES: usize = 3;
/// Forward pages one live refresh may follow.
pub const LIVE_UPDATE_PAGES: usize = 5;

pub fn newest_path(conversation: &str, before: i64) -> String {
    format!(
        "/api/v2/conversations/{conversation}/updates?before_sequence={before}&limit={RUN_UPDATES_PAGE_MAX}"
    )
}
pub fn after_path(conversation: &str, after: i64) -> String {
    format!(
        "/api/v2/conversations/{conversation}/updates?after_sequence={after}&limit={RUN_UPDATES_PAGE_MAX}"
    )
}

/// A forward page of this conversation, every row after `after`.
pub fn valid_forward(page: &RunUpdates, conversation: &str, after: i64) -> bool {
    page.is_valid()
        && page.conversation_id.to_string() == conversation
        && page.updates.iter().all(|u| u.sequence > after)
}

/// A newest-first page of this conversation: all rows below `before`, no cursor.
pub fn valid_newest(page: &RunUpdates, conversation: &str, before: i64) -> bool {
    page.is_valid()
        && page.conversation_id.to_string() == conversation
        && page.next_after_sequence.is_none()
        && page.updates.iter().all(|u| u.sequence < before)
}

/// The cursor of the next older page: only below a full page.
pub fn older_cursor(page: &RunUpdates) -> Option<i64> {
    if page.updates.len() < usize::from(RUN_UPDATES_PAGE_MAX) {
        return None;
    }
    page.updates.first().map(|u| u.sequence)
}

/// Keeps the newest `UPDATES_KEPT` updates. A known update may change only
/// its marks (removed stays removed); another payload at its place is refused.
pub fn merge(
    rows: &mut BTreeMap<i64, RunUpdate>,
    incoming: &[RunUpdate],
) -> Result<(), &'static str> {
    if incoming.iter().any(|update| {
        rows.get(&update.sequence).is_some_and(|known| {
            known.run_id != update.run_id || known.payload_id != update.payload_id
        })
    }) {
        return Err("Update identity changed");
    }
    for update in incoming {
        let mut next = update.clone();
        next.payload_removed |= rows
            .get(&update.sequence)
            .is_some_and(|known| known.payload_removed);
        rows.insert(update.sequence, next);
    }
    while rows.len() > UPDATES_KEPT {
        rows.pop_first();
    }
    Ok(())
}

/// The updates the chat shows, oldest first: not removed, not a run's final
/// answer (its accepted reply shows it, including one accepted after this
/// list was read), and not older than `from`, the oldest input on screen.
pub fn shown(updates: &[RunUpdate], replies: &[AcceptedResult], from: i64) -> Vec<RunUpdate> {
    let answers: BTreeSet<String> = replies
        .iter()
        .filter_map(|reply| reply.payload_id.as_ref().map(ToString::to_string))
        .collect();
    updates
        .iter()
        .filter(|u| !u.payload_removed && !u.final_answer && u.sequence >= from)
        .filter(|u| !answers.contains(&u.payload_id.to_string()))
        .cloned()
        .collect()
}

/// An update as a row of the answer text reader, which keys texts by payload
/// and run and a suppressed reply by sequence.
pub fn reader_row(update: &RunUpdate) -> AcceptedResult {
    AcceptedResult {
        run_id: update.run_id.clone(),
        completion_event_id: EventId(update.payload_id.0),
        acceptance_event_id: EventId(update.payload_id.0),
        acceptance_sequence: update.sequence,
        payload_id: Some(update.payload_id.clone()),
        payload_removed: update.payload_removed,
        auto_accepted: false,
    }
}
