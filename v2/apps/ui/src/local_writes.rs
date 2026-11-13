//! Local folder writes waiting for the owner (ORK-804), as every tab and
//! device of the owner shows them: a notice under the app header, an
//! "Approve write" state on the conversation's list row and a mark in the
//! tab title. A write can only be allowed in the browser tab serving the
//! folder, so every text says where to act. Presentation only.
use crate::conversation_status::Tone;
use crate::sidebar::WorkState;
use orkestr_v2_contracts::{LocalFileWriteWaiting, LocalFileWritesWaiting};

/// Notice lines shown at most; the rest is counted.
pub const NOTICE_LINES_MAX: usize = 3;

pub fn valid(reply: &LocalFileWritesWaiting) -> bool {
    reply.is_valid()
}

/// The waiting writes of the conversation `id`, if any.
pub fn waiting_for<'a>(
    waiting: &'a [LocalFileWriteWaiting],
    id: &str,
) -> Option<&'a LocalFileWriteWaiting> {
    waiting.iter().find(|w| w.conversation_id.to_string() == id)
}

fn files(writes: u32) -> String {
    if writes == 1 {
        "a file".into()
    } else {
        format!("{writes} files")
    }
}

/// Where the owner can answer: the one tab serving the folder.
pub fn where_to_act(waiting: &LocalFileWriteWaiting) -> String {
    format!(
        "Allow or refuse it in the browser tab where the folder \u{201c}{}\u{201d} is connected.",
        waiting.folder_name
    )
}

/// One line per conversation, oldest first: what waits and where to act.
pub fn notice_lines(waiting: &[LocalFileWriteWaiting]) -> Vec<String> {
    let mut lines: Vec<String> = waiting
        .iter()
        .take(NOTICE_LINES_MAX)
        .map(|w| {
            format!(
                "\u{201c}{}\u{201d} wants to change {} in your folder. {}",
                w.conversation_name,
                files(w.writes),
                where_to_act(w)
            )
        })
        .collect();
    if waiting.len() > NOTICE_LINES_MAX {
        let more = waiting.len() - NOTICE_LINES_MAX;
        lines.push(format!(
            "{more} more chat{} {} waiting for a write.",
            if more == 1 { "" } else { "s" },
            if more == 1 { "is" } else { "are" }
        ));
    }
    lines
}

/// The notice's heading.
pub fn notice_heading(waiting: &[LocalFileWriteWaiting]) -> &'static str {
    if waiting.iter().map(|w| w.writes).sum::<u32>() > 1 {
        "Approve writes"
    } else {
        "Approve write"
    }
}

/// The list row's state: it needs the owner, so it outranks every other one.
pub fn row_state(waiting: &LocalFileWriteWaiting) -> WorkState {
    WorkState {
        label: if waiting.writes == 1 {
            "Approve write".into()
        } else {
            format!("Approve {} writes", waiting.writes)
        },
        tone: Tone::Attention,
    }
}

/// The row state's longer description (tooltip and screen readers).
pub fn row_hint(waiting: &LocalFileWriteWaiting) -> String {
    format!(
        "The thread wants to change {} in your folder. {}",
        files(waiting.writes),
        where_to_act(waiting)
    )
}
