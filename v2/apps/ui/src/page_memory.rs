//! Tab-scoped recovery of unsent drafts, durable intake receipts and uncertain
//! window requests across a full page reload. Stored per authenticated owner
//! namespace; it never grants authority: every restored item is re-validated
//! and still needs an explicit Send to continue.
use crate::{beta_inputs::SavedInputs, beta_window::WindowIntents, Draft, Submission};
use orkestr_v2_contracts::{ExecutionWindowRequest, MessageInput};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const VERSION: u32 = 1;
/// Drafts kept per owner; oldest conversations beyond this are not stored.
pub const DRAFTS_MAX: usize = 64;
/// Encoded bytes; browsers cap tab storage near 5 MB.
pub const BYTES_MAX: usize = 2 * 1024 * 1024;
const TEXT_MAX: usize = 32768;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredDraft {
    conversation: String,
    text: String,
    pending: Option<MessageInput>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredIntent {
    conversation: String,
    request: ExecutionWindowRequest,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u32,
    drafts: Vec<StoredDraft>,
    saved: Vec<crate::beta_inputs::SavedInput>,
    intents: Vec<StoredIntent>,
}

/// Storage key for one owner namespace; `None` for anything but a canonical UUID.
pub fn key(global: &str) -> Option<String> {
    let id = serde_json::from_value::<orkestr_v2_contracts::ConversationId>(
        serde_json::Value::String(global.into()),
    )
    .ok()?;
    (!id.0.is_nil() && id.to_string() == global).then(|| format!("orkestr.v2.page.{global}"))
}

/// Encode recoverable page state; `None` when there is nothing worth keeping.
pub fn encode(
    drafts: &BTreeMap<String, Draft>,
    saved: &SavedInputs,
    intents: &WindowIntents,
) -> Option<String> {
    let mut stored = Stored {
        version: VERSION,
        drafts: drafts
            .iter()
            .filter(|(_, d)| !d.text.is_empty() || d.pending.is_some())
            .filter(|(_, d)| d.text.len() <= TEXT_MAX)
            .take(DRAFTS_MAX)
            .map(|(conversation, d)| StoredDraft {
                conversation: conversation.clone(),
                text: d.text.clone(),
                pending: d.pending.as_ref().map(|p| p.input.clone()),
            })
            .collect(),
        saved: saved.all().to_vec(),
        intents: intents
            .pending_requests()
            .map(|(conversation, request)| StoredIntent {
                conversation: conversation.into(),
                request: request.clone(),
            })
            .collect(),
    };
    if stored.drafts.is_empty() && stored.saved.is_empty() && stored.intents.is_empty() {
        return None;
    }
    let mut text = serde_json::to_string(&stored).ok()?;
    // Receipts and work requests outrank draft text when space runs out.
    while text.len() > BYTES_MAX && !stored.drafts.is_empty() {
        stored.drafts.pop();
        text = serde_json::to_string(&stored).ok()?;
    }
    (text.len() <= BYTES_MAX).then_some(text)
}

/// Restore into the current page without overwriting anything newer in memory.
/// Returns how many drafts, receipts and work requests were recovered.
pub fn restore(
    raw: &str,
    drafts: &mut BTreeMap<String, Draft>,
    saved: &mut SavedInputs,
    intents: &mut WindowIntents,
) -> (usize, usize, usize) {
    let Ok(stored) = serde_json::from_str::<Stored>(raw) else {
        return (0, 0, 0);
    };
    if stored.version != VERSION || raw.len() > BYTES_MAX {
        return (0, 0, 0);
    }
    let mut counts = (0, 0, 0);
    for draft in stored.drafts.into_iter().take(DRAFTS_MAX) {
        if key(&draft.conversation).is_none()
            || draft.text.len() > TEXT_MAX
            || drafts.contains_key(&draft.conversation)
            || draft.pending.as_ref().is_some_and(|p| {
                p.client_message_id.is_empty()
                    || p.text.trim().is_empty()
                    || p.text.len() > TEXT_MAX
            })
        {
            continue;
        }
        // Accepting the restored send clears the text only if it was not edited since.
        let edited = draft.pending.as_ref().is_some_and(|p| p.text != draft.text);
        drafts.insert(
            draft.conversation,
            Draft {
                text: draft.text,
                revision: if edited { 2 } else { 1 },
                pending: draft.pending.map(|input| Submission { input, revision: 1 }),
                quote: None,
            },
        );
        counts.0 += 1;
    }
    for input in stored.saved {
        if saved.retain_receipt(input) {
            counts.1 += 1;
        }
    }
    for intent in stored.intents {
        if intents.pending(&intent.conversation).is_none()
            && intents
                .prepare(&intent.conversation, intent.request)
                .is_some()
        {
            counts.2 += 1;
        }
    }
    counts
}
