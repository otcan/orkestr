//! Display canonical input and accepted results in event order without inventing messages.
//! Conversation posts (assistant-side messages from outside a run) follow the
//! event they were written after, ordered by creation time among themselves.
use orkestr_v2_contracts::{
    AcceptedResult, ConversationPost, Message, MessageRevisionKind, MessageRevisionNotice,
    MessageRevisionSource, ReplyTo,
};
use std::collections::{BTreeMap, BTreeSet};

/// Keep a bounded inline history. Only a removal tombstone may change a known row.
pub fn merge_replies(
    rows: &mut BTreeMap<i64, AcceptedResult>,
    incoming: &[AcceptedResult],
) -> Result<(), &'static str> {
    for row in incoming {
        if let Some(old) = rows.get(&row.acceptance_sequence) {
            let mut comparison = row.clone();
            comparison.payload_removed = old.payload_removed;
            if &comparison != old {
                return Err("Accepted reply identity changed");
            }
        }
    }
    for row in incoming {
        let mut next = row.clone();
        next.payload_removed |= rows
            .get(&row.acceptance_sequence)
            .is_some_and(|old| old.payload_removed);
        rows.insert(row.acceptance_sequence, next);
    }
    while rows.len() > 100 {
        rows.pop_first();
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Input {
    pub id: String,
    pub sequence: i64,
    pub actor: String,
    pub text: String,
    pub reply_to: Option<ReplyTo>,
    pub revisions: InputRevisions,
}
/// How an input was edited or removed. `Input::text` already shows the result.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct InputRevisions {
    /// The server would accept an edit or removal of this message.
    pub can_revise: bool,
    /// The revision the owner is looking at (0: the original).
    pub revision: i64,
    pub edited_from: Option<MessageRevisionSource>,
    pub deleted: bool,
    /// Set on a row that only announces a change to another message.
    pub notice: Option<MessageRevisionNotice>,
}
/// The compact line a notice row shows instead of a message.
pub fn notice_line(notice: &MessageRevisionNotice) -> &'static str {
    match (notice.change.kind, notice.change.source) {
        // A web change reaches the assistant, not a copy already on WhatsApp.
        (MessageRevisionKind::Edit, MessageRevisionSource::Web) => {
            "You edited a message. The assistant was told. A copy already sent to WhatsApp stays as it was."
        }
        (MessageRevisionKind::Edit, MessageRevisionSource::Whatsapp) => {
            "You edited a message in WhatsApp. The assistant was told."
        }
        (MessageRevisionKind::Delete, MessageRevisionSource::Web) => {
            "You deleted a message. The assistant was told. A copy already sent to WhatsApp stays as it was."
        }
        (MessageRevisionKind::Delete, MessageRevisionSource::Whatsapp) => {
            "You deleted a message in WhatsApp. The assistant was told."
        }
    }
}
/// The label on an edited message.
pub fn edited_label(source: MessageRevisionSource) -> &'static str {
    match source {
        MessageRevisionSource::Web => "Edited",
        MessageRevisionSource::Whatsapp => "Edited in WhatsApp",
    }
}
/// Drop the relay's `[Replying to ...]` line from the displayed text: the same
/// context is shown as a quoted bubble instead. The model still reads the line.
pub fn without_reply_line(text: &str) -> String {
    let mut kept = Vec::new();
    let mut dropped = false;
    for paragraph in text.split("\n\n") {
        let line = paragraph.trim();
        if !dropped
            && line.starts_with("[Replying to ")
            && line.ends_with(']')
            && !line.contains('\n')
        {
            dropped = true;
        } else {
            kept.push(paragraph);
        }
    }
    kept.join("\n\n")
}
/// Drop the adapter's leading `[Chat rules v...]` paragraph from the displayed
/// text. The model still reads the line; the owner sees what they wrote.
pub fn without_rules_line(text: &str) -> String {
    match text.split_once("\n\n") {
        Some((first, rest))
            if first.starts_with("[Chat rules v")
                && first.ends_with(']')
                && !first.contains('\n') =>
        {
            rest.to_owned()
        }
        _ => text.to_owned(),
    }
}
/// A short label for the quoted message: who said it, or that it is unavailable.
pub fn quote_label(quote: &ReplyTo) -> &'static str {
    if quote.unavailable {
        "Replying to an unavailable message"
    } else if quote.is_own_reply {
        "Replying to Orkestr"
    } else if quote.author.as_deref() == Some(OWNER_AUTHOR) {
        "Replying to you"
    } else {
        "Replying to an earlier message"
    }
}

/// `author` of a quote of the owner's own message, set by the web UI.
pub const OWNER_AUTHOR: &str = "owner";
/// Characters of the quoted text in the visible `[Replying to …]` line (as the WhatsApp relay).
pub const REPLY_SNIPPET_MAX: usize = 80;

/// Who wrote a message the owner replies to from the web UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteAuthor {
    Owner,
    Assistant,
    Other,
}

/// Collapse whitespace and cut to `max` characters with an ellipsis.
pub fn clip(text: &str, max: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// The quote kept with a web UI reply, shaped like a WhatsApp reply's.
pub fn quote(message_id: &str, author: QuoteAuthor, text: &str) -> ReplyTo {
    let message_id: String = message_id.chars().take(300).collect();
    ReplyTo {
        message_id: (!message_id.is_empty()).then_some(message_id),
        author: Some(match author {
            QuoteAuthor::Owner => OWNER_AUTHOR.into(),
            QuoteAuthor::Assistant => "orkestr".into(),
            QuoteAuthor::Other => "participant".into(),
        }),
        sent_at: None,
        text: clip(text, ReplyTo::TEXT_MAX),
        is_own_reply: author == QuoteAuthor::Assistant,
        unavailable: false,
    }
}

/// The visible line the model reads, in the WhatsApp relay's format.
pub fn reply_line(quote: &ReplyTo) -> String {
    if quote.unavailable {
        return "[Replying to an unavailable message]".into();
    }
    let who = if quote.is_own_reply {
        "Orkestr message"
    } else if quote.author.as_deref() == Some(OWNER_AUTHOR) {
        "your message"
    } else {
        "earlier message"
    };
    format!(
        "[Replying to {who}: \"{}\"]",
        clip(&quote.text, REPLY_SNIPPET_MAX)
    )
}

/// Message text for a reply: the reply line, a blank line, then the text.
pub fn with_reply_line(text: &str, quote: &ReplyTo) -> String {
    format!("{}\n\n{text}", reply_line(quote))
}

/// A leading `[Replying to …]` line of a message that has no structured
/// quote (V1 history): `(label, quoted snippet, remaining text)`.
pub fn split_reply_line(text: &str) -> Option<(String, String, String)> {
    let (first, rest) = text.split_once("\n\n")?;
    let line = first.trim();
    if !line.starts_with("[Replying to ") || !line.ends_with(']') || line.contains('\n') {
        return None;
    }
    let inner = &line["[Replying to ".len()..line.len() - 1];
    let (who, snippet) = match inner.split_once(": \"") {
        Some((who, snippet)) => (who, snippet.strip_suffix('"').unwrap_or(snippet)),
        None => (inner, ""),
    };
    let who = who.split(" from ").next().unwrap_or(who);
    let label = match who {
        "Orkestr message" => "Replying to Orkestr",
        "your message" => "Replying to you",
        "an unavailable message" => "Replying to an unavailable message",
        _ => "Replying to an earlier message",
    };
    Some((label.into(), snippet.into(), rest.to_string()))
}
impl From<&Message> for Input {
    fn from(value: &Message) -> Self {
        let state = value.revisions.as_ref();
        let latest = state.and_then(|state| state.latest.as_ref());
        let deleted = latest.is_some_and(|latest| latest.kind == MessageRevisionKind::Delete);
        // `Message::text` is the immutable original; the latest change shows over it.
        let shown = latest
            .filter(|latest| latest.kind == MessageRevisionKind::Edit)
            .and_then(|latest| latest.text.as_deref())
            .unwrap_or(&value.text);
        let text = without_rules_line(shown);
        let text = if deleted {
            String::new()
        } else if value.reply_to.is_some() {
            without_reply_line(&text)
        } else {
            text
        };
        Self {
            id: value.message_id.to_string(),
            sequence: value.sequence,
            actor: value.actor_kind.clone(),
            text,
            reply_to: value.reply_to.clone(),
            revisions: InputRevisions {
                can_revise: state.is_some_and(|state| state.can_revise) && !deleted,
                revision: latest.map_or(0, |latest| latest.revision),
                edited_from: latest
                    .filter(|latest| latest.kind == MessageRevisionKind::Edit)
                    .map(|latest| latest.source),
                deleted,
                notice: state.and_then(|state| state.notice_for.clone()),
            },
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Input(Input),
    Reply(AcceptedResult),
    Post(ConversationPost),
}
impl Row {
    /// The event sequence: a post reports the event it follows.
    pub fn sequence(&self) -> i64 {
        match self {
            Self::Input(row) => row.sequence,
            Self::Reply(row) => row.acceptance_sequence,
            Self::Post(row) => row.after_sequence,
        }
    }
    /// Events first at their sequence, then posts after it by creation time.
    fn order(&self) -> (i64, u8, i64) {
        match self {
            Self::Post(row) => (row.after_sequence, 1, row.created_ms),
            _ => (self.sequence(), 0, 0),
        }
    }
    /// A row that only announces a change to another message.
    pub fn is_notice(&self) -> bool {
        matches!(self, Self::Input(row) if row.revisions.notice.is_some())
    }
    /// A removal the agent never saw leaves nothing worth a line in the chat.
    pub fn is_silent_notice(&self) -> bool {
        matches!(self, Self::Input(row) if row.revisions.notice.as_ref().is_some_and(|notice| !notice.agent_notified))
    }
    /// Whether the owner can reply to this row.
    pub fn is_replyable(&self) -> bool {
        match self {
            Self::Input(row) => row.revisions.notice.is_none() && !row.revisions.deleted,
            Self::Reply(_) => true,
            Self::Post(_) => false,
        }
    }
    /// Whether a suppressed reply hides this row: only the reply itself, never
    /// a post that follows it and so reports the same event sequence.
    pub fn is_silenced(&self, silent: &BTreeSet<i64>) -> bool {
        matches!(self, Self::Reply(row) if silent.contains(&row.acceptance_sequence))
    }
    pub fn key(&self) -> String {
        match self {
            Self::Input(row) => format!("input-{}", row.id),
            Self::Reply(row) => format!("reply-{}", row.acceptance_event_id),
            Self::Post(row) => format!("post-{}", row.id),
        }
    }
}
pub fn ordered(
    inputs: &[Input],
    replies: &[AcceptedResult],
    posts: &[ConversationPost],
) -> Result<Vec<Row>, &'static str> {
    let mut rows: Vec<_> = inputs
        .iter()
        .cloned()
        .map(Row::Input)
        .chain(replies.iter().cloned().map(Row::Reply))
        .collect();
    rows.sort_by_key(Row::sequence);
    if rows.iter().any(|row| row.sequence() <= 0)
        || rows
            .windows(2)
            .any(|pair| pair[0].sequence() == pair[1].sequence())
    {
        return Err("Conversation order could not be verified. Reload history.");
    }
    // A post that follows an event older than the row before the oldest one
    // on screen would be shown out of place, so it is left out.
    let first = rows.first().map_or(0, |row| row.sequence());
    rows.extend(
        posts
            .iter()
            .filter(|post| post.after_sequence >= first - 1)
            .cloned()
            .map(Row::Post),
    );
    rows.sort_by_key(Row::order);
    Ok(rows)
}
