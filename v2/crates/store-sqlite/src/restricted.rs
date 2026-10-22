//! Restricted threads: policy, transcript, approvals, session grants and the
//! append-only audit. The owner-facing methods take the owner's credential; the
//! `restricted_*` runner methods are for the server's own broker task and are
//! scoped by the thread row's owner. The model never reaches either.
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::Row;
use uuid::Uuid;

type Result<T> = std::result::Result<T, ResourceError>;

pub const SESSION_GRANT_TTL_MS: i64 = 8 * 60 * 60 * 1000;
const CONTEXT_ROWS: i64 = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictedRunnerThread {
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub session_id: String,
    pub policy: RestrictedPolicy,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictedContextRow {
    pub role: String,
    pub content: Option<String>,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictedApprovalStatus {
    pub state: RestrictedApprovalState,
    pub scope: Option<RestrictedApprovalScope>,
}

fn scope_str(s: RestrictedApprovalScope) -> &'static str {
    match s {
        RestrictedApprovalScope::Once => "once",
        RestrictedApprovalScope::Session => "session",
    }
}
fn scope_parse(s: Option<String>) -> Option<RestrictedApprovalScope> {
    match s.as_deref() {
        Some("once") => Some(RestrictedApprovalScope::Once),
        Some("session") => Some(RestrictedApprovalScope::Session),
        _ => None,
    }
}
fn uuid_conv(s: String) -> Result<ConversationId> {
    Uuid::parse_str(&s).map(ConversationId).map_err(unavailable)
}

impl Store {
    // ---- owner-facing -------------------------------------------------------

    pub async fn restricted_thread(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<RestrictedThread> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let row = sqlx::query("SELECT * FROM restricted_threads WHERE conversation_id=?")
            .bind(conversation.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(match row {
            None => RestrictedThread {
                schema_version: RESTRICTED_SCHEMA_VERSION,
                conversation_id: conversation.clone(),
                revision: 0,
                enabled: false,
                provider_kind: RESTRICTED_PROVIDER_KIND.into(),
                policy: None,
                session_id: None,
                last_owner_input_ms: None,
                updated_at_ms: 0,
            },
            Some(r) => RestrictedThread {
                schema_version: RESTRICTED_SCHEMA_VERSION,
                conversation_id: conversation.clone(),
                revision: r.get("revision"),
                enabled: r.get::<i64, _>("enabled") == 1,
                provider_kind: r.get("provider_kind"),
                policy: serde_json::from_str(&r.get::<String, _>("policy_json")).ok(),
                session_id: Some(r.get("session_id")),
                last_owner_input_ms: r.get("last_owner_input_ms"),
                updated_at_ms: r.get("updated_at_ms"),
            },
        })
    }

    /// Full replacement of the policy, guarded by revision. The first save also
    /// starts the thread at the current end of the conversation: messages sent before
    /// it was restricted are never replayed to the model.
    pub async fn update_restricted_thread(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        update: &RestrictedThreadUpdate,
    ) -> Result<RestrictedThread> {
        if !update.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let policy_json = serde_json::to_string(&update.policy).map_err(unavailable)?;
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let current: Option<i64> =
            sqlx::query_scalar("SELECT revision FROM restricted_threads WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?;
        if current.unwrap_or(0) != update.expected_revision {
            return Err(ResourceError::Conflict("restricted_revision_mismatch"));
        }
        let now = now_ms();
        if current.is_none() {
            sqlx::query("INSERT INTO restricted_threads(conversation_id,owner_id,enabled,revision,policy_json,session_id,cursor_sequence,updated_at_ms) VALUES(?,?,?,1,?,?,(SELECT sequence FROM conversations WHERE id=?),?)")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .bind(update.enabled as i64)
                .bind(&policy_json)
                .bind(Uuid::new_v4().to_string())
                .bind(conversation.to_string())
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        } else {
            sqlx::query("UPDATE restricted_threads SET enabled=?,policy_json=?,revision=revision+1,updated_at_ms=? WHERE conversation_id=?")
                .bind(update.enabled as i64)
                .bind(&policy_json)
                .bind(now)
                .bind(conversation.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        self.restricted_thread(credential, owner, conversation)
            .await
    }

    /// New session id: every "allow for this session" approval stops applying.
    pub async fn reset_restricted_session(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<()> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let changed = sqlx::query(
            "UPDATE restricted_threads SET session_id=?,updated_at_ms=? WHERE conversation_id=?",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(now_ms())
        .bind(conversation.to_string())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if changed == 0 {
            return Err(ResourceError::NotFound);
        }
        sqlx::query("DELETE FROM restricted_grants WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)
    }

    pub async fn restricted_audit_page(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        before: Option<i64>,
        limit: u32,
    ) -> Result<RestrictedAuditPage> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let rows = sqlx::query("SELECT * FROM restricted_audit WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?")
            .bind(conversation.to_string())
            .bind(before.unwrap_or(i64::MAX))
            .bind(limit.clamp(1, 200) as i64)
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let records = rows
            .iter()
            .map(|r| {
                Ok(RestrictedAuditRecord {
                    id: r.get("id"),
                    session_id: r.get("session_id"),
                    at_ms: r.get("at_ms"),
                    action: r.get("action"),
                    request: r.get("request_json"),
                    decision: RestrictedDecision::parse(&r.get::<String, _>("decision"))
                        .ok_or(ResourceError::Unavailable)?,
                    decider: RestrictedDecider::parse(&r.get::<String, _>("decider"))
                        .ok_or(ResourceError::Unavailable)?,
                    reason: r.get("reason"),
                    approval_id: r.get("approval_id"),
                    outcome: r.get("outcome"),
                    result_summary: r.get("result_summary"),
                    finished_at_ms: r.get("finished_at_ms"),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(RestrictedAuditPage { records })
    }

    pub async fn restricted_approvals(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        pending_only: bool,
    ) -> Result<RestrictedApprovalList> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        expire_due(&mut tx, Some(conversation)).await?;
        let rows = sqlx::query("SELECT * FROM restricted_approvals WHERE conversation_id=? AND (?=0 OR state='pending') ORDER BY created_at_ms DESC LIMIT 50")
            .bind(conversation.to_string())
            .bind(pending_only as i64)
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let approvals = rows
            .iter()
            .map(|r| {
                let key: Option<String> = r.get("grant_key");
                Ok(RestrictedApproval {
                    id: r.get("id"),
                    audit_id: r.get("audit_id"),
                    action: r.get("action"),
                    summary: r.get("summary"),
                    session_grant_label: key.map(|k| {
                        k.split_once(':')
                            .map_or(k.clone(), |(a, b)| format!("{} {b}", a.replace('_', " ")))
                    }),
                    state: RestrictedApprovalState::parse(&r.get::<String, _>("state"))
                        .ok_or(ResourceError::Unavailable)?,
                    scope: scope_parse(r.get("scope")),
                    created_at_ms: r.get("created_at_ms"),
                    expires_at_ms: r.get("expires_at_ms"),
                    decided_at_ms: r.get("decided_at_ms"),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(RestrictedApprovalList { approvals })
    }

    /// The owner's one tap. Only the owner credential reaches this; a pending
    /// request is decided exactly once.
    pub async fn decide_restricted_approval(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        approval_id: &str,
        decision: &RestrictedApprovalDecision,
    ) -> Result<RestrictedApproval> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        expire_due(&mut tx, Some(conversation)).await?;
        let row = sqlx::query("SELECT state,grant_key,session_id FROM restricted_approvals WHERE id=? AND conversation_id=?")
            .bind(approval_id)
            .bind(conversation.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(ResourceError::NotFound)?;
        if row.get::<String, _>("state") != "pending" {
            return Err(ResourceError::Conflict("approval_not_pending"));
        }
        let key: Option<String> = row.get("grant_key");
        let now = now_ms();
        let scope = if decision.approve {
            decision.scope
        } else {
            RestrictedApprovalScope::Once
        };
        if decision.approve && scope == RestrictedApprovalScope::Session {
            let Some(key) = key else {
                return Err(ResourceError::Invalid);
            };
            let current: String = sqlx::query_scalar(
                "SELECT session_id FROM restricted_threads WHERE conversation_id=?",
            )
            .bind(conversation.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
            if current != row.get::<String, _>("session_id") {
                return Err(ResourceError::Conflict("session_changed"));
            }
            sqlx::query("INSERT OR REPLACE INTO restricted_grants(conversation_id,session_id,grant_key,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?)")
                .bind(conversation.to_string())
                .bind(current)
                .bind(key)
                .bind(now)
                .bind(now + SESSION_GRANT_TTL_MS)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        sqlx::query("UPDATE restricted_approvals SET state=?,scope=?,decided_at_ms=? WHERE id=? AND state='pending'")
            .bind(if decision.approve { "approved" } else { "denied" })
            .bind(scope_str(scope))
            .bind(now)
            .bind(approval_id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let list = self
            .restricted_approvals(credential, owner, conversation, false)
            .await?;
        list.approvals
            .into_iter()
            .find(|a| a.id == approval_id)
            .ok_or(ResourceError::NotFound)
    }

    pub async fn restricted_messages_page(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> Result<RestrictedMessagePage> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let rows = sqlx::query("SELECT id,role,content,created_at_ms FROM restricted_messages WHERE conversation_id=? AND id>? AND (role='notice' OR (role='assistant' AND tool_calls_json IS NULL)) ORDER BY id LIMIT ?")
            .bind(conversation.to_string())
            .bind(after)
            .bind(limit.clamp(1, 200) as i64)
            .fetch_all(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(RestrictedMessagePage {
            messages: rows
                .iter()
                .map(|r| RestrictedMessage {
                    id: r.get("id"),
                    role: r.get("role"),
                    content: r.get("content"),
                    created_at_ms: r.get("created_at_ms"),
                })
                .collect(),
        })
    }

    /// Whether this conversation is an enabled restricted thread (windows must not run it).
    pub async fn is_restricted_conversation(&self, conversation: &ConversationId) -> Result<bool> {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM restricted_threads WHERE conversation_id=? AND enabled=1",
        )
        .bind(conversation.to_string())
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)?;
        Ok(n == 1)
    }

    // ---- runner (server's own broker task) ----------------------------------

    pub async fn restricted_enabled_threads(&self) -> Result<Vec<RestrictedRunnerThread>> {
        let rows = sqlx::query("SELECT owner_id,conversation_id,session_id,policy_json FROM restricted_threads WHERE enabled=1")
            .fetch_all(&self.pool)
            .await
            .map_err(unavailable)?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                Some(RestrictedRunnerThread {
                    owner_id: OwnerId(Uuid::parse_str(&r.get::<String, _>("owner_id")).ok()?),
                    conversation_id: uuid_conv(r.get("conversation_id")).ok()?,
                    session_id: r.get("session_id"),
                    policy: serde_json::from_str(&r.get::<String, _>("policy_json")).ok()?,
                })
            })
            .collect())
    }

    /// Take the next unprocessed owner message (one at a time per thread). The cursor
    /// moves before the model runs, so a crash never replays a message with effects.
    pub async fn restricted_take_input(
        &self,
        thread: &RestrictedRunnerThread,
    ) -> Result<Option<(i64, String)>> {
        let conv = thread.conversation_id.to_string();
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let state = sqlx::query("SELECT cursor_sequence,inflight_sequence,session_id FROM restricted_threads WHERE conversation_id=? AND enabled=1")
            .bind(&conv)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
        let Some(state) = state else { return Ok(None) };
        if state.get::<Option<i64>, _>("inflight_sequence").is_some() {
            return Ok(None);
        }
        let next = sqlx::query("SELECT sequence,text FROM messages WHERE conversation_id=? AND sequence>? AND actor_kind='owner' ORDER BY sequence LIMIT 1")
            .bind(&conv)
            .bind(state.get::<i64, _>("cursor_sequence"))
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
        let Some(next) = next else { return Ok(None) };
        let (sequence, text): (i64, String) = (next.get("sequence"), next.get("text"));
        let now = now_ms();
        sqlx::query("UPDATE restricted_threads SET cursor_sequence=?,inflight_sequence=?,last_owner_input_ms=? WHERE conversation_id=?")
            .bind(sequence)
            .bind(sequence)
            .bind(now)
            .bind(&conv)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        sqlx::query("INSERT INTO restricted_messages(conversation_id,session_id,role,content,source_sequence,created_at_ms) VALUES(?,?,'user',?,?,?)")
            .bind(&conv)
            .bind(state.get::<String, _>("session_id"))
            .bind(&text)
            .bind(sequence)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(Some((sequence, text)))
    }

    pub async fn restricted_finish_input(&self, conversation: &ConversationId) -> Result<()> {
        sqlx::query("UPDATE restricted_threads SET inflight_sequence=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&self.pool)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    /// Startup: a turn that was running when the server stopped is closed with a
    /// notice, and approvals nobody can still be waiting on are expired.
    pub async fn restricted_recover(&self) -> Result<u32> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let rows = sqlx::query("SELECT conversation_id,session_id FROM restricted_threads WHERE inflight_sequence IS NOT NULL").fetch_all(&mut *tx).await.map_err(unavailable)?;
        let now = now_ms();
        for r in &rows {
            sqlx::query("INSERT INTO restricted_messages(conversation_id,session_id,role,content,created_at_ms) VALUES(?,?,'notice','The server restarted while this message was being handled. Nothing further was done; please send it again.',?)")
                .bind(r.get::<String, _>("conversation_id")).bind(r.get::<String, _>("session_id")).bind(now).execute(&mut *tx).await.map_err(unavailable)?;
        }
        sqlx::query("UPDATE restricted_threads SET inflight_sequence=NULL WHERE inflight_sequence IS NOT NULL").execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("UPDATE restricted_audit SET decision='deny',decider='system',reason='the server restarted before the owner answered',outcome='denied',result_summary='not allowed: the server restarted before the owner answered',finished_at_ms=? WHERE decision='ask' AND outcome IS NULL")
            .bind(now).execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("UPDATE restricted_approvals SET expires_at_ms=0 WHERE state='pending'")
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        expire_due(&mut tx, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(rows.len() as u32)
    }

    pub async fn restricted_append(
        &self,
        conversation: &ConversationId,
        session: &str,
        role: &str,
        content: Option<&str>,
        tool_calls_json: Option<&str>,
        tool_call_id: Option<&str>,
    ) -> Result<i64> {
        let r = sqlx::query("INSERT INTO restricted_messages(conversation_id,session_id,role,content,tool_calls_json,tool_call_id,created_at_ms) VALUES(?,?,?,?,?,?,?)")
            .bind(conversation.to_string()).bind(session).bind(role).bind(content).bind(tool_calls_json).bind(tool_call_id).bind(now_ms())
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(r.last_insert_rowid())
    }

    /// Recent transcript of the current session, oldest first.
    pub async fn restricted_context(
        &self,
        conversation: &ConversationId,
        session: &str,
    ) -> Result<Vec<RestrictedContextRow>> {
        let rows = sqlx::query("SELECT role,content,tool_calls_json,tool_call_id FROM (SELECT * FROM restricted_messages WHERE conversation_id=? AND session_id=? AND role<>'notice' ORDER BY id DESC LIMIT ?) ORDER BY id")
            .bind(conversation.to_string()).bind(session).bind(CONTEXT_ROWS).fetch_all(&self.pool).await.map_err(unavailable)?;
        Ok(rows
            .iter()
            .map(|r| RestrictedContextRow {
                role: r.get("role"),
                content: r.get("content"),
                tool_calls_json: r.get("tool_calls_json"),
                tool_call_id: r.get("tool_call_id"),
            })
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn restricted_audit_begin(
        &self,
        conversation: &ConversationId,
        session: &str,
        action: &str,
        request: &str,
        decision: RestrictedDecision,
        decider: RestrictedDecider,
        reason: Option<&str>,
    ) -> Result<i64> {
        let r = sqlx::query("INSERT INTO restricted_audit(conversation_id,session_id,at_ms,action,request_json,decision,decider,reason) VALUES(?,?,?,?,?,?,?,?)")
            .bind(conversation.to_string()).bind(session).bind(now_ms()).bind(action.chars().take(64).collect::<String>())
            .bind(request.chars().take(16000).collect::<String>()).bind(decision.as_str()).bind(decider.as_str()).bind(reason.map(|r| r.chars().take(1000).collect::<String>()))
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(r.last_insert_rowid())
    }
    /// Settle an `ask` row exactly once with the final decision.
    pub async fn restricted_audit_settle(
        &self,
        id: i64,
        decision: RestrictedDecision,
        decider: RestrictedDecider,
        reason: Option<&str>,
        approval_id: Option<&str>,
    ) -> Result<()> {
        sqlx::query("UPDATE restricted_audit SET decision=?,decider=?,reason=?,approval_id=? WHERE id=? AND decision='ask'")
            .bind(decision.as_str()).bind(decider.as_str()).bind(reason.map(|r| r.chars().take(1000).collect::<String>())).bind(approval_id).bind(id)
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(())
    }
    pub async fn restricted_audit_result(
        &self,
        id: i64,
        outcome: &str,
        summary: &str,
    ) -> Result<()> {
        sqlx::query("UPDATE restricted_audit SET outcome=?,result_summary=?,finished_at_ms=? WHERE id=? AND outcome IS NULL")
            .bind(outcome).bind(summary.chars().take(4000).collect::<String>()).bind(now_ms()).bind(id)
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn restricted_approval_create(
        &self,
        conversation: &ConversationId,
        session: &str,
        audit_id: i64,
        action: &str,
        summary: &str,
        grant_key: Option<&str>,
        ttl_ms: i64,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        sqlx::query("INSERT INTO restricted_approvals(id,conversation_id,session_id,audit_id,action,summary,grant_key,state,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,'pending',?,?)")
            .bind(&id).bind(conversation.to_string()).bind(session).bind(audit_id).bind(action).bind(summary.chars().take(2000).collect::<String>()).bind(grant_key).bind(now).bind(now + ttl_ms)
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(id)
    }
    pub async fn restricted_approval_status(&self, id: &str) -> Result<RestrictedApprovalStatus> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        expire_due(&mut tx, None).await?;
        let row = sqlx::query("SELECT state,scope FROM restricted_approvals WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(ResourceError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(RestrictedApprovalStatus {
            state: RestrictedApprovalState::parse(&row.get::<String, _>("state"))
                .ok_or(ResourceError::Unavailable)?,
            scope: scope_parse(row.get("scope")),
        })
    }
    pub async fn restricted_grant_active(
        &self,
        conversation: &ConversationId,
        session: &str,
        key: &str,
    ) -> Result<bool> {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM restricted_grants WHERE conversation_id=? AND session_id=? AND grant_key=? AND expires_at_ms>?")
            .bind(conversation.to_string()).bind(session).bind(key).bind(now_ms()).fetch_one(&self.pool).await.map_err(unavailable)?;
        Ok(n == 1)
    }
}

async fn expire_due(
    tx: &mut sqlx::SqliteConnection,
    conversation: Option<&ConversationId>,
) -> Result<()> {
    let filter = conversation.map(|c| c.to_string());
    sqlx::query("UPDATE restricted_approvals SET state='expired',decided_at_ms=?1 WHERE state='pending' AND expires_at_ms<=?1 AND (?2 IS NULL OR conversation_id=?2)")
        .bind(now_ms())
        .bind(filter)
        .execute(tx)
        .await
        .map_err(unavailable)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::conversation_resources::tests_settings::Case;
    use orkestr_v2_contracts::*;

    fn policy(ws: &str) -> RestrictedPolicy {
        serde_json::from_value(serde_json::json!({"workspace": ws, "endpoint": "stub"})).unwrap()
    }

    #[tokio::test]
    async fn audit_is_append_only_and_settles_once() {
        let case = Case::new().await;
        let t = case
            .store
            .update_restricted_thread(
                &case.token,
                &case.owner,
                &case.conversation,
                &RestrictedThreadUpdate {
                    expected_revision: 0,
                    enabled: true,
                    policy: policy("/srv/ws"),
                },
            )
            .await
            .unwrap();
        let session = t.session_id.unwrap();
        let id = case
            .store
            .restricted_audit_begin(
                &case.conversation,
                &session,
                "send_message",
                "{}",
                RestrictedDecision::Ask,
                RestrictedDecider::Policy,
                Some("r"),
            )
            .await
            .unwrap();
        // Deleting is refused by the schema, for everyone.
        assert!(sqlx::query("DELETE FROM restricted_audit")
            .execute(&case.store.pool)
            .await
            .is_err());
        // The request, action and time can never be rewritten.
        for sql in [
            "UPDATE restricted_audit SET request_json='{\"x\":1}'",
            "UPDATE restricted_audit SET action='read_file'",
            "UPDATE restricted_audit SET at_ms=0",
            "UPDATE restricted_audit SET session_id='other'",
        ] {
            assert!(
                sqlx::query(sql).execute(&case.store.pool).await.is_err(),
                "{sql}"
            );
        }
        // An ask settles once; a second settle is ignored.
        case.store
            .restricted_audit_settle(
                id,
                RestrictedDecision::Allow,
                RestrictedDecider::Owner,
                None,
                None,
            )
            .await
            .unwrap();
        case.store
            .restricted_audit_settle(
                id,
                RestrictedDecision::Deny,
                RestrictedDecider::System,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(sqlx::query("UPDATE restricted_audit SET decision='deny'")
            .execute(&case.store.pool)
            .await
            .is_err());
        // The result is written once.
        case.store
            .restricted_audit_result(id, "ok", "first")
            .await
            .unwrap();
        case.store
            .restricted_audit_result(id, "error", "second")
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE restricted_audit SET result_summary='x'")
                .execute(&case.store.pool)
                .await
                .is_err()
        );
        let rec = &case
            .store
            .restricted_audit_page(&case.token, &case.owner, &case.conversation, None, 10)
            .await
            .unwrap()
            .records[0];
        assert_eq!(
            (
                rec.decision,
                rec.decider,
                rec.outcome.as_deref(),
                rec.result_summary.as_deref()
            ),
            (
                RestrictedDecision::Allow,
                RestrictedDecider::Owner,
                Some("ok"),
                Some("first")
            )
        );
        case.finish().await;
    }

    #[tokio::test]
    async fn policy_updates_are_owner_scoped_and_revision_guarded() {
        let case = Case::new().await;
        let other = case.conversation("other").await;
        let update = |rev| RestrictedThreadUpdate {
            expected_revision: rev,
            enabled: true,
            policy: policy("/srv/ws"),
        };
        assert!(case
            .store
            .update_restricted_thread("nope", &case.owner, &case.conversation, &update(0))
            .await
            .is_err());
        assert!(case
            .store
            .update_restricted_thread(&case.token, &case.owner, &case.conversation, &update(3))
            .await
            .is_err());
        let first = case
            .store
            .update_restricted_thread(&case.token, &case.owner, &case.conversation, &update(0))
            .await
            .unwrap();
        assert_eq!((first.revision, first.enabled), (1, true));
        assert!(
            case.store
                .update_restricted_thread(&case.token, &case.owner, &case.conversation, &update(0))
                .await
                .is_err(),
            "stale revision"
        );
        let mut bad = update(1);
        bad.policy.workspace = "/srv/ws,dst=/etc".into();
        assert!(case
            .store
            .update_restricted_thread(&case.token, &case.owner, &case.conversation, &bad)
            .await
            .is_err());
        assert!(!case.store.is_restricted_conversation(&other).await.unwrap());
        assert!(case
            .store
            .is_restricted_conversation(&case.conversation)
            .await
            .unwrap());
        case.finish().await;
    }
}
