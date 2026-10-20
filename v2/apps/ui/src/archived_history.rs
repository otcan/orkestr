//! Archived (imported V1) history: display-only provenance, never native input.
use orkestr_v2_contracts::{ArchivedEntry, ArchivedHistoryPage, ARCHIVED_PAGE_MAX};
use std::collections::BTreeMap;

/// Rows retained in one mounted conversation; older pages are re-readable.
pub const RETAINED: usize = 2000;
/// Long legacy messages render a preview first; the full text stays one click away.
pub const PREVIEW_CHARS: usize = 4000;

#[derive(Clone, Default)]
pub struct ArchivedTimeline {
    conversation: String,
    entries: BTreeMap<i64, ArchivedEntry>,
    next_after: Option<i64>,
    loaded: bool,
    trimmed: bool,
}

impl ArchivedTimeline {
    pub fn new(conversation: &str) -> Self {
        Self {
            conversation: conversation.into(),
            ..Self::default()
        }
    }
    /// Cursor for the next read; `None` once the archive is exhausted.
    pub fn cursor(&self) -> Option<i64> {
        if !self.loaded {
            Some(0)
        } else {
            self.next_after
        }
    }
    pub fn loaded(&self) -> bool {
        self.loaded
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn trimmed(&self) -> bool {
        self.trimmed
    }
    pub fn entries(&self) -> impl Iterator<Item = &ArchivedEntry> {
        self.entries.values()
    }
    /// Apply one page read with `after`; foreign, reordered or changed rows fail closed.
    pub fn apply(&mut self, after: i64, page: ArchivedHistoryPage) -> Result<(), &'static str> {
        if page.conversation_id.0.is_nil() || page.conversation_id.to_string() != self.conversation
        {
            return Err("Archived history belongs to another conversation.");
        }
        if after < 0 || self.cursor() != Some(after) {
            return Err("Archived history page is out of order.");
        }
        if page.entries.len() > ARCHIVED_PAGE_MAX as usize {
            return Err("Archived history page is too large.");
        }
        let mut previous = after;
        for entry in &page.entries {
            if entry.archive_sequence <= previous || !entry.message.is_valid() {
                return Err("Archived history could not be verified.");
            }
            previous = entry.archive_sequence;
            if self
                .entries
                .get(&entry.archive_sequence)
                .is_some_and(|old| old != entry)
            {
                return Err("Archived history changed; reload to verify.");
            }
        }
        if let Some(next) = page.next_after {
            if page.entries.is_empty() || next < previous {
                return Err("Archived history cursor could not be verified.");
            }
        }
        for entry in page.entries {
            self.entries.insert(entry.archive_sequence, entry);
        }
        while self.entries.len() > RETAINED {
            self.entries.pop_first();
            self.trimmed = true;
        }
        self.next_after = page.next_after;
        self.loaded = true;
        Ok(())
    }
}

/// Owner-facing label for a legacy role; unknown roles stay visible verbatim.
pub fn role_label(role: &str) -> &str {
    match role {
        "user" => "You",
        "assistant" => "Assistant",
        "system" => "System",
        "tool" => "Tool",
        other => other,
    }
}

/// Preview of a long message and whether text was shortened.
pub fn preview(text: &str) -> (&str, bool) {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((index, _)) => (&text[..index], true),
        None => (text, false),
    }
}
