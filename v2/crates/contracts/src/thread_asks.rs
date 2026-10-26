//! Scoped agent-to-agent requests between conversations of one owner
//! ("ask thread X"). The asking conversation's agent holds an owner-issued
//! thread-ask grant; Core admits the request as an attributed input of the
//! target conversation, the trusted scheduler queues the target's ordinary
//! Deep turn and routes its final answer back exactly once, either as the
//! result of a `collect` call from the still-running asker or as one new
//! attributed input of the asking conversation.
use crate::ConversationId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Header carrying a per-conversation thread-ask grant (64 lowercase hex).
pub const THREAD_ASK_GRANT_HEADER: &str = "x-orkestr-thread-ask-grant";
/// Request text bound; the composed target input stays below the message limit.
pub const THREAD_ASK_TEXT_MAX: usize = 8_000;
/// Explicit target allowlist bound for one grant.
pub const THREAD_ASK_TARGETS_MAX: usize = 32;
/// At most this many unsettled requests per asking conversation.
pub const THREAD_ASK_OPEN_MAX: i64 = 4;
/// At most this many accepted requests per asking conversation per hour.
pub const THREAD_ASK_HOURLY_MAX: i64 = 12;
/// A request admitted while handling another thread's request is depth 1;
/// a request from such a turn would be depth 2 and is refused (no loops).
pub const THREAD_ASK_MAX_DEPTH: i64 = 1;

fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

/// Owner issues (rotates) the grant of one asking conversation. `targets`
/// absent means every other conversation of the same owner.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadAskGrantRequest {
    #[serde(default)]
    pub targets: Option<Vec<ConversationId>>,
}
impl ThreadAskGrantRequest {
    pub fn is_valid(&self, source: &ConversationId) -> bool {
        self.targets.as_ref().is_none_or(|targets| {
            !targets.is_empty()
                && targets.len() <= THREAD_ASK_TARGETS_MAX
                && targets.iter().all(|t| !t.0.is_nil() && t != source)
                && targets
                    .iter()
                    .enumerate()
                    .all(|(i, t)| !targets[..i].contains(t))
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAskGrant {
    pub conversation_id: ConversationId,
    pub issued: bool,
    pub generation: i64,
    pub targets: Option<Vec<ConversationId>>,
}
/// Returned once at issue; only its hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadAskGrantIssued {
    pub grant: String,
    pub binding: ThreadAskGrant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadAskRequest {
    /// Caller-chosen idempotency key, unique per asking conversation.
    pub request_key: String,
    pub target_conversation_id: ConversationId,
    pub text: String,
}
impl ThreadAskRequest {
    pub fn is_valid(&self) -> bool {
        key(&self.request_key)
            && !self.target_conversation_id.0.is_nil()
            && !self.text.trim().is_empty()
            && self.text.len() <= THREAD_ASK_TEXT_MAX
            && !self.text.contains('\0')
    }
}

/// Lifecycle as the asking agent may report it. `Sent` is not progress:
/// it only means the request is recorded in the target conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadAskState {
    /// Input recorded in the target conversation; no target turn yet.
    Sent,
    /// The target's Deep turn for it is admitted but has not started.
    Admitted,
    /// The target's agent is working on it (or its answer awaits review).
    Running,
    /// The target's turn finished and was accepted; the answer exists.
    Answered,
    /// The target will not answer it (stated `reason`).
    Failed,
}
impl ThreadAskState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Answered | Self::Failed)
    }
}

/// How the settled outcome reached the asking conversation, exactly once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadAskReturn {
    /// Returned as the result of `collect` to a running asking turn.
    ToolResult,
    /// Admitted as one attributed input of the asking conversation.
    Input,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAskView {
    pub ask_id: Uuid,
    pub request_key: String,
    pub source_conversation_id: ConversationId,
    pub target_conversation_id: ConversationId,
    pub target_name: String,
    pub state: ThreadAskState,
    /// Closed machine detail, for example `awaiting_owner_review` or a failure reason.
    pub detail: Option<String>,
    /// Honest one-line wording for the asking agent to relay.
    pub status_text: String,
    pub created_ms: i64,
    pub settled_ms: Option<i64>,
    pub returned: Option<ThreadAskReturn>,
    /// The asking conversation's input carrying the outcome (`returned=input`).
    pub reply_message_id: Option<Uuid>,
    /// Present only in the one `collect` response that returns it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAskReceipt {
    /// False for an exact replay of the same request key and body.
    pub created: bool,
    pub ask: ThreadAskView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAskTarget {
    pub conversation_id: ConversationId,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadAskList {
    pub asks: Vec<ThreadAskView>,
}

/// Wording shared by Core and the CLI. Never claims progress that did not happen.
pub fn thread_ask_status_text(
    state: ThreadAskState,
    detail: Option<&str>,
    target: &str,
    returned: Option<ThreadAskReturn>,
) -> String {
    match state {
        ThreadAskState::Sent => format!(
            "Sent to \"{target}\", not processed yet: the target thread has not started a turn for it."
        ),
        ThreadAskState::Admitted => format!(
            "Queued in \"{target}\": its turn is admitted but its agent has not started yet."
        ),
        ThreadAskState::Running if detail == Some("awaiting_owner_review") => format!(
            "\"{target}\" finished a reply, which awaits the owner's review there; not answered yet."
        ),
        ThreadAskState::Running => {
            format!("\"{target}\" is working on it now; not answered yet.")
        }
        ThreadAskState::Answered => match returned {
            Some(ThreadAskReturn::ToolResult) => {
                format!("\"{target}\" answered; the answer was returned to the asking turn.")
            }
            Some(ThreadAskReturn::Input) => format!(
                "\"{target}\" answered; the answer was delivered to this thread as a new message."
            ),
            None => format!("\"{target}\" answered; collect the answer now."),
        },
        ThreadAskState::Failed => format!(
            "\"{target}\" did not answer: {}.",
            detail.unwrap_or("failed")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wording_never_reports_sent_as_progress() {
        let sent = thread_ask_status_text(ThreadAskState::Sent, None, "Hosting", None);
        assert!(sent.contains("not processed yet"));
        assert!(!sent.to_lowercase().contains("delivered"));
        let review = thread_ask_status_text(
            ThreadAskState::Running,
            Some("awaiting_owner_review"),
            "Hosting",
            None,
        );
        assert!(review.contains("not answered yet"));
        assert!(thread_ask_status_text(
            ThreadAskState::Failed,
            Some("target_run_failed"),
            "Hosting",
            None
        )
        .contains("did not answer: target_run_failed"));
    }
    #[test]
    fn request_and_grant_validation() {
        let source = ConversationId(Uuid::from_u128(1));
        let target = ConversationId(Uuid::from_u128(2));
        let ok = ThreadAskRequest {
            request_key: "ask-1".into(),
            target_conversation_id: target.clone(),
            text: "Which Bedrock region?".into(),
        };
        assert!(ok.is_valid());
        for bad in [
            ThreadAskRequest {
                request_key: "a b".into(),
                ..ok.clone()
            },
            ThreadAskRequest {
                text: " ".into(),
                ..ok.clone()
            },
            ThreadAskRequest {
                text: "x".repeat(THREAD_ASK_TEXT_MAX + 1),
                ..ok.clone()
            },
            ThreadAskRequest {
                target_conversation_id: ConversationId(Uuid::nil()),
                ..ok.clone()
            },
        ] {
            assert!(!bad.is_valid());
        }
        assert!(ThreadAskGrantRequest { targets: None }.is_valid(&source));
        assert!(ThreadAskGrantRequest {
            targets: Some(vec![target.clone()])
        }
        .is_valid(&source));
        for bad in [
            Some(vec![]),
            Some(vec![source.clone()]),
            Some(vec![target.clone(), target.clone()]),
        ] {
            assert!(!ThreadAskGrantRequest { targets: bad }.is_valid(&source));
        }
    }
}
