//! Owner input into a linked V1 chat. The draft's pending submission keeps
//! its key until V1 answers definitely, so every retry after an unknown
//! outcome reuses the key and V1 admits the message once.
use crate::Draft;
use orkestr_v2_contracts::{V1ThreadInput, V1_INPUT_TEXT_MAX};

/// Drafts of linked V1 chats share the composer draft map under this key.
pub fn draft_key(thread: &str) -> String {
    format!("v1:{thread}")
}

/// The request for the current draft: the pending one when a send is still
/// unconfirmed (same key and text), otherwise a new one under `key`.
pub fn prepare(draft: &mut Draft, key: String) -> Result<V1ThreadInput, &'static str> {
    if draft.pending.is_none() && draft.text.len() > V1_INPUT_TEXT_MAX {
        return Err("A V1 message must contain at most 16384 UTF-8 bytes.");
    }
    let input = draft.prepare(key)?;
    let input = V1ThreadInput {
        client_message_id: input.client_message_id,
        text: input.text,
    };
    if input.is_valid() {
        Ok(input)
    } else {
        draft.pending = None;
        Err("Message could not be prepared.")
    }
}

/// History poll interval: quick while V1 works or right after a send, so
/// replies (including the coordinator's) appear live.
pub fn poll_ms(working: bool, quick_polls_left: u32) -> u32 {
    if working || quick_polls_left > 0 {
        2500
    } else {
        8000
    }
}

/// Quick polls after a send (about two minutes).
pub const QUICK_POLLS_AFTER_SEND: u32 = 48;

/// What a failed send means for the pending submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failed {
    /// No definite answer (network, timeout, 5xx): retry keeps the key.
    Retry,
    /// V1 or the server refused: the draft stays, a new send gets a new key.
    Refused,
    /// The session ended.
    Expired,
}

pub fn failed(status: u16) -> Failed {
    match status {
        401 => Failed::Expired,
        400 | 403 | 404 | 409 | 422 => Failed::Refused,
        _ => Failed::Retry,
    }
}
