//! An owner's edits and removals of their own earlier messages.
//!
//! A message row is never changed. A revision references it and carries its
//! own notice row, admitted through the ordinary queue, so a running turn is
//! never touched and the agent hears of the change in order:
//!
//! - Nothing of this message has started and the owner typed it in the browser:
//!   the unstarted input is retired, the agent only ever receives the corrected
//!   text, and a removal costs no turn.
//! - The agent has or may have read it: it receives a notice after whatever is
//!   running now, and decides what the correction means for work already done.
use crate::intake::{admit_in_transaction, message_origin};
use crate::production_runtime::retired_inputs::{retire_if_unstarted, InputRetirement};
use crate::{digest, Store};
use orkestr_v2_contracts::*;
use sqlx::{sqlite::SqliteRow, Row, SqliteConnection};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRevisionError {
    Invalid,
    Unauthorized,
    NotFound,
    /// Not the owner's own message: a member's, the assistant's or the system's.
    NotOwnMessage,
    AlreadyDeleted,
    Stale,
    Unchanged,
    Conflict,
    /// Restricted threads do not run through the input queue.
    Restricted,
    Unavailable,
}
use MessageRevisionError as E;
type Result<T> = std::result::Result<T, MessageRevisionError>;

fn db(_: impl std::fmt::Display) -> MessageRevisionError {
    E::Unavailable
}
fn store(error: orkestr_v2_application::StoreError) -> MessageRevisionError {
    use orkestr_v2_application::StoreError as S;
    match error {
        S::NotFound => E::NotFound,
        S::Invalid => E::Invalid,
        S::Conflict => E::Conflict,
        _ => E::Unavailable,
    }
}
fn runtime(_: orkestr_v2_application::runtime::RuntimeStoreError) -> MessageRevisionError {
    E::Unavailable
}

/// A notice row's request key, which also marks it as not editable.
pub(crate) const NOTICE_KEY_PREFIX: &str = "message-revision:";

/// Who wrote a message decides whether its owner may revise it.
///
/// `actor_kind` is `owner` for every input, including a group member's text
/// sent through the owner's session and timer or relay input, so it proves
/// nothing here. Only a stated owner author counts, or, for a message without
/// one, that it was typed in the owner's own browser session.
pub(crate) fn revisable(request_key: &str, author: Option<&str>, session: Option<&str>) -> bool {
    let system = !matches!(message_origin(request_key), "web" | "api");
    !system
        && match author {
            Some(author) => matches!(author, "owner" | "v1_owner"),
            None => session == Some("browser"),
        }
}

fn is_marker_line(paragraph: &str) -> bool {
    let line = paragraph.trim();
    line.starts_with('[') && line.ends_with(']') && !line.contains('\n')
}

/// Up to `max` characters of what the owner wrote, past the relay's marker lines.
fn excerpt(text: &str, max: usize) -> String {
    let body = text
        .split("\n\n")
        .skip_while(|paragraph| is_marker_line(paragraph))
        .collect::<Vec<_>>()
        .join(" ");
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(max).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// The original's `[Replying to …]` line, kept when its input is replaced.
fn reply_line(text: &str) -> Option<&str> {
    text.split("\n\n")
        .take(3)
        .find(|paragraph| paragraph.starts_with("[Replying to ") && is_marker_line(paragraph))
}

const EXCERPT_CHARS: usize = 120;

/// What the agent receives. `None`: nothing, as it never saw the message.
fn notice_text(
    request: &MessageRevisionRequest,
    original: &str,
    earlier: &str,
    sequence: i64,
    agent_saw_earlier_text: bool,
) -> Option<String> {
    match (request.kind, agent_saw_earlier_text) {
        (MessageRevisionKind::Delete, false) => None,
        (MessageRevisionKind::Delete, true) => Some(format!(
            "[Message removed] The owner deleted their earlier message (message #{sequence} in this conversation). Disregard it and do not act on it further. If you already acted on it, tell the owner what was done."
        )),
        (MessageRevisionKind::Edit, false) => {
            let text = request.text.as_deref().unwrap_or_default();
            Some(match reply_line(original) {
                Some(line) => format!("{line}\n\n{text}"),
                None => text.to_owned(),
            })
        }
        (MessageRevisionKind::Edit, true) => Some(format!(
            "[Message corrected] The owner edited their earlier message (message #{sequence} in this conversation). The corrected text below replaces it. If you already acted on the earlier version, check whether anything needs to change, and tell the owner if it does.\n\nEarlier version began: \"{}\"\n\nCorrected text:\n{}",
            excerpt(earlier, EXCERPT_CHARS),
            request.text.as_deref().unwrap_or_default(),
        )),
    }
}

fn request_digest(message: &MessageId, request: &MessageRevisionRequest) -> String {
    digest(&format!(
        "{message}\n{}\n{}\n{}",
        request.kind.as_str(),
        request.source.as_str(),
        request.text.as_deref().unwrap_or_default()
    ))
}

async fn replay(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    request: &MessageRevisionRequest,
    payload: &str,
) -> Result<Option<MessageRevisionReceipt>> {
    let Some(row) = sqlx::query("SELECT payload_digest,receipt_json FROM message_revisions WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
        .fetch_optional(&mut *tx).await.map_err(db)? else { return Ok(None) };
    if row.get::<String, _>("payload_digest") != payload {
        return Err(E::Conflict);
    }
    let mut receipt: MessageRevisionReceipt =
        serde_json::from_str(row.get("receipt_json")).map_err(db)?;
    receipt.duplicate = true;
    Ok(Some(receipt))
}

async fn latest(tx: &mut SqliteConnection, message: &MessageId) -> Result<Option<SqliteRow>> {
    sqlx::query("SELECT revision,kind,text,notice_message_id,agent_saw_earlier_text FROM message_revisions WHERE target_message_id=? ORDER BY revision DESC LIMIT 1")
        .bind(message.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)
}

impl Store {
    /// Record an edit or removal of the owner's own message, atomically with
    /// the notice the agent receives and the retirement of any unstarted input.
    pub async fn revise_owner_message(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        message: &MessageId,
        request: &MessageRevisionRequest,
    ) -> Result<MessageRevisionReceipt> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(E::Unauthorized);
        }
        if conversation.0.is_nil() || message.0.is_nil() || !request.is_valid() {
            return Err(E::Invalid);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let hash = digest(credential);
        let session = sqlx::query("SELECT kind,service_credential_id FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(&hash).bind(owner.to_string()).fetch_optional(&mut *tx).await.map_err(db)?
            .ok_or(E::Unauthorized)?;
        let session_kind: String = session.get("kind");
        let service: Option<String> = session.get("service_credential_id");
        let payload = request_digest(message, request);
        if let Some(receipt) = replay(&mut tx, owner, conversation, request, &payload).await? {
            if &receipt.message_id != message {
                return Err(E::Conflict);
            }
            return Ok(receipt);
        }
        let restricted: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM restricted_threads WHERE conversation_id=? AND enabled=1",
        )
        .bind(conversation.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if restricted != 0 {
            return Err(E::Restricted);
        }
        let target = sqlx::query("SELECT m.text,m.request_key,m.sequence,a.author,s.session_kind FROM messages m LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN message_request_sources s ON s.message_id=m.id AND s.owner_id=m.owner_id WHERE m.id=? AND m.conversation_id=? AND m.owner_id=? AND m.actor_kind='owner'")
            .bind(message.to_string()).bind(conversation.to_string()).bind(owner.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(E::NotFound)?;
        let original: String = target.get("text");
        let author: Option<String> = target.get("author");
        let request_key: String = target.get("request_key");
        let origin_session: Option<String> = target.get("session_kind");
        if !revisable(&request_key, author.as_deref(), origin_session.as_deref()) {
            return Err(E::NotOwnMessage);
        }
        let prior = latest(&mut tx, message).await?;
        if prior
            .as_ref()
            .is_some_and(|row| row.get::<String, _>("kind") == "delete")
        {
            return Err(E::AlreadyDeleted);
        }
        let current_revision = prior
            .as_ref()
            .map_or(0, |row| row.get::<i64, _>("revision"));
        if request
            .expected_revision
            .is_some_and(|expected| expected != current_revision)
        {
            return Err(E::Stale);
        }
        let earlier = prior
            .as_ref()
            .and_then(|row| row.get::<Option<String>, _>("text"))
            .unwrap_or_else(|| original.clone());
        if request.kind == MessageRevisionKind::Edit
            && request.text.as_deref().map(str::trim) == Some(earlier.trim())
        {
            return Err(E::Unchanged);
        }
        let revision_id = Uuid::new_v4();
        // The newest live form of this message: the original, or the notice
        // that replaced it. If it is still unstarted, withdraw it now.
        let head = match &prior {
            Some(row) => MessageId(
                row.get::<String, _>("notice_message_id")
                    .parse()
                    .map_err(db)?,
            ),
            None => message.clone(),
        };
        let reason = match request.kind {
            MessageRevisionKind::Edit => "Replaced by the owner's edit before it started",
            MessageRevisionKind::Delete => "Removed by the owner before it started",
        };
        let head_key = format!("{NOTICE_KEY_PREFIX}{revision_id}:head");
        // A connector still drives the input it admitted (window, reply
        // tracking), so withdrawing that one here would strand its delivery.
        // It stays, and the agent gets the correction as a notice instead.
        let head_outcome = if prior.is_some() || origin_session.as_deref() == Some("browser") {
            retire_if_unstarted(&mut tx, owner, conversation, &head, &head_key, reason)
                .await
                .map_err(runtime)?
        } else {
            InputRetirement::NotRetirable
        };
        // An unstarted head only proves the agent never saw this message if
        // nothing earlier in the chain reached it either.
        let earlier_chain_seen = prior
            .as_ref()
            .is_some_and(|row| row.get::<i64, _>("agent_saw_earlier_text") == 1);
        let agent_saw_earlier_text =
            head_outcome == InputRetirement::NotRetirable || earlier_chain_seen;
        let sequence: i64 = target.get("sequence");
        let notice = notice_text(
            request,
            &original,
            &earlier,
            sequence,
            agent_saw_earlier_text,
        );
        // A removal the agent never saw still needs a row: the conversation
        // shows the change through it. The row is retired straight away below.
        let input = MessageInput {
            client_message_id: format!("{NOTICE_KEY_PREFIX}{revision_id}"),
            text: notice.clone().unwrap_or_else(|| {
                format!("[Message removed] The owner deleted message #{sequence} before it was processed.")
            }),
        };
        let admission = admit_in_transaction(&mut tx, owner, conversation, &input)
            .await
            .map_err(store)?;
        let notice_id = admission.receipt.message_id.clone();
        sqlx::query("INSERT INTO message_request_sources(message_id,owner_id,session_kind,credential_hash,service_credential_id) VALUES(?,?,?,?,?)")
            .bind(notice_id.to_string()).bind(owner.to_string())
            .bind(&session_kind).bind(&hash).bind(service)
            .execute(&mut *tx).await.map_err(db)?;
        if let Some(author) = &author {
            sqlx::query("INSERT INTO message_authors(message_id,author) VALUES (?,?)")
                .bind(notice_id.to_string())
                .bind(author)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        if request.kind == MessageRevisionKind::Edit && !agent_saw_earlier_text {
            sqlx::query("INSERT OR IGNORE INTO message_reply_to(message_id,reply_to) SELECT ?,reply_to FROM message_reply_to WHERE message_id=?")
                .bind(notice_id.to_string())
                .bind(message.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        let agent_notified = notice.is_some();
        if agent_notified {
            // An inbox row alone runs nothing. Queue its window here, in order
            // behind any running turn, so no client has to stay open for it.
            crate::production_runtime::enqueue_trusted_intent(
                &mut tx,
                owner,
                conversation,
                notice_id.clone(),
                admission.receipt.event_id.clone(),
                &input.client_message_id,
                format!("{NOTICE_KEY_PREFIX}{revision_id}:window"),
            )
            .await
            .map_err(runtime)?;
        } else {
            let key = format!("{NOTICE_KEY_PREFIX}{revision_id}:notice");
            let outcome =
                retire_if_unstarted(&mut tx, owner, conversation, &notice_id, &key, reason)
                    .await
                    .map_err(runtime)?;
            if outcome != InputRetirement::Retired {
                return Err(E::Unavailable);
            }
        }
        let clock: i64 =
            sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let receipt = MessageRevisionReceipt {
            revision_id,
            conversation_id: conversation.clone(),
            message_id: message.clone(),
            revision: current_revision + 1,
            kind: request.kind,
            notice_message_id: notice_id.clone(),
            notice_event_id: admission.receipt.event_id.clone(),
            notice_sequence: admission.receipt.sequence,
            agent_notified,
            agent_saw_earlier_text,
            created_at_ms: clock,
            duplicate: false,
        };
        sqlx::query("INSERT INTO message_revisions(id,owner_id,conversation_id,target_message_id,revision,kind,text,source,request_key,payload_digest,notice_message_id,agent_notified,agent_saw_earlier_text,credential_hash,session_kind,created_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(revision_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(message.to_string()).bind(receipt.revision).bind(request.kind.as_str())
            .bind(&request.text).bind(request.source.as_str()).bind(&request.request_key).bind(&payload)
            .bind(notice_id.to_string()).bind(i64::from(agent_notified)).bind(i64::from(agent_saw_earlier_text))
            .bind(&hash).bind(&session_kind).bind(clock)
            .bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }

    /// The audit record of one message, oldest change first.
    pub async fn message_revision_history(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        message: &MessageId,
    ) -> Result<MessageRevisionHistory> {
        let original: String = sqlx::query_scalar(
            "SELECT text FROM messages WHERE id=? AND conversation_id=? AND owner_id=?",
        )
        .bind(message.to_string())
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .ok_or(E::NotFound)?;
        let rows = sqlx::query("SELECT id,revision,kind,text,source,notice_message_id,agent_notified,agent_saw_earlier_text,created_at_ms FROM message_revisions WHERE target_message_id=? AND conversation_id=? AND owner_id=? ORDER BY revision")
            .bind(message.to_string()).bind(conversation.to_string()).bind(owner.to_string())
            .fetch_all(&self.pool).await.map_err(db)?;
        let revisions = rows
            .iter()
            .map(|row| {
                Ok(MessageRevisionEntry {
                    revision_id: row.get::<String, _>("id").parse().map_err(db)?,
                    revision: row.get("revision"),
                    kind: MessageRevisionKind::parse(row.get("kind")).ok_or(E::Unavailable)?,
                    text: row.get("text"),
                    source: MessageRevisionSource::parse(row.get("source"))
                        .ok_or(E::Unavailable)?,
                    notice_message_id: MessageId(
                        row.get::<String, _>("notice_message_id")
                            .parse()
                            .map_err(db)?,
                    ),
                    agent_notified: row.get::<i64, _>("agent_notified") == 1,
                    agent_saw_earlier_text: row.get::<i64, _>("agent_saw_earlier_text") == 1,
                    created_at_ms: row.get("created_at_ms"),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(MessageRevisionHistory {
            conversation_id: conversation.clone(),
            message_id: message.clone(),
            original_text: original,
            revisions,
        })
    }
}

/// Snapshot columns for one `messages m` row. `a` and `s` are its author and
/// request source; both subqueries are bounded unique-index lookups.
pub(crate) const SNAPSHOT_COLUMNS: &str = "a.author AS revision_author,s.session_kind AS revision_session,
 (SELECT json_object('revision',v.revision,'kind',v.kind,'text',v.text,'source',v.source,'revised_at_ms',v.created_at_ms)
  FROM message_revisions v WHERE v.target_message_id=m.id ORDER BY v.revision DESC LIMIT 1) AS revision_latest,
 (SELECT json_object('target_message_id',n.target_message_id,'change',json_object('revision',n.revision,'kind',n.kind,'text',n.text,'source',n.source,'revised_at_ms',n.created_at_ms),'agent_notified',json(iif(n.agent_notified=1,'true','false')),'agent_saw_earlier_text',json(iif(n.agent_saw_earlier_text=1,'true','false')))
  FROM message_revisions n WHERE n.notice_message_id=m.id) AS revision_notice";
pub(crate) const SNAPSHOT_JOINS: &str = "LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN message_request_sources s ON s.message_id=m.id AND s.owner_id=m.owner_id";

/// The revision facts of one snapshot row; `None` for a row with none to show.
pub(crate) fn snapshot_state(row: &SqliteRow) -> Option<MessageRevisionState> {
    let latest: Option<MessageRevisionSummary> = row
        .get::<Option<String>, _>("revision_latest")
        .and_then(|json| serde_json::from_str(&json).ok());
    let notice_for: Option<MessageRevisionNotice> = row
        .get::<Option<String>, _>("revision_notice")
        .and_then(|json| serde_json::from_str(&json).ok());
    let deleted = latest
        .as_ref()
        .is_some_and(|summary| summary.kind == MessageRevisionKind::Delete);
    let author: Option<String> = row.get("revision_author");
    let session: Option<String> = row.get("revision_session");
    let can_revise = !deleted
        && notice_for.is_none()
        && revisable(
            row.get("request_key"),
            author.as_deref(),
            session.as_deref(),
        );
    (can_revise || latest.is_some() || notice_for.is_some()).then_some(MessageRevisionState {
        can_revise,
        latest,
        notice_for,
    })
}

#[cfg(test)]
#[path = "message_revisions_tests.rs"]
mod tests;
