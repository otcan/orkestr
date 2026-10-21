//! Display canonical input and accepted results in event order without inventing messages.
use orkestr_v2_contracts::{AcceptedResult, Message, ReplyTo};
use std::collections::BTreeMap;

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
/// A short label for the quoted message: who said it, or that it is unavailable.
pub fn quote_label(quote: &ReplyTo) -> &'static str {
    if quote.unavailable {
        "Replying to an unavailable message"
    } else if quote.is_own_reply {
        "Replying to Orkestr"
    } else {
        "Replying to an earlier message"
    }
}
impl From<&Message> for Input {
    fn from(value: &Message) -> Self {
        let text = if value.reply_to.is_some() {
            without_reply_line(&value.text)
        } else {
            value.text.clone()
        };
        Self {
            id: value.message_id.to_string(),
            sequence: value.sequence,
            actor: value.actor_kind.clone(),
            text,
            reply_to: value.reply_to.clone(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Input(Input),
    Reply(AcceptedResult),
}
impl Row {
    pub fn sequence(&self) -> i64 {
        match self {
            Self::Input(row) => row.sequence,
            Self::Reply(row) => row.acceptance_sequence,
        }
    }
    pub fn key(&self) -> String {
        match self {
            Self::Input(row) => format!("input-{}", row.id),
            Self::Reply(row) => format!("reply-{}", row.acceptance_event_id),
        }
    }
}
pub fn ordered(inputs: &[Input], replies: &[AcceptedResult]) -> Result<Vec<Row>, &'static str> {
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
    Ok(rows)
}
