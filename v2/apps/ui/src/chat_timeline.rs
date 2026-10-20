//! Display canonical input and accepted results in event order without inventing messages.
use orkestr_v2_contracts::{AcceptedResult, Message};
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
}
impl From<&Message> for Input {
    fn from(value: &Message) -> Self {
        Self {
            id: value.message_id.to_string(),
            sequence: value.sequence,
            actor: value.actor_kind.clone(),
            text: value.text.clone(),
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
