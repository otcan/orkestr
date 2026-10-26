//! Scoped agent requests between conversations of one owner ("ask thread X").
//!
//! Authority: the owner issues a per-conversation thread-ask grant (shown
//! once, stored as a hash, optionally limited to an explicit target list).
//! A grant only works while its conversation has a running Deep turn, which
//! the request is pinned to; it never reaches another owner's conversations.
//! Every authenticated attempt, refused or not, is appended to the audit.
//!
//! Delivery: the request is admitted as an attributed ordinary input of the
//! target conversation. The trusted timer scheduler (never the HTTP caller)
//! queues the target's Deep window intent, observes the target's run for that
//! exact input and settles the outcome. The outcome returns exactly once: as
//! the `collect` result of a running asking turn, or, after the asking turn
//! ended, as one attributed input of the asking conversation (with its own
//! queued Deep turn). A write-once `return_path` decides which, atomically.
use super::*;
use crate::conversation_resources::{now_ms, owned};
use crate::ResourceError;
use orkestr_v2_contracts::{
    thread_ask_status_text, ConversationId, EventId, MessageId, MessageInput, ThreadAskGrant,
    ThreadAskGrantIssued, ThreadAskGrantRequest, ThreadAskList, ThreadAskReceipt, ThreadAskRequest,
    ThreadAskReturn, ThreadAskState, ThreadAskTarget, ThreadAskView, THREAD_ASK_HOURLY_MAX,
    THREAD_ASK_MAX_DEPTH, THREAD_ASK_OPEN_MAX,
};
use sqlx::{sqlite::SqliteRow, Sqlite, Transaction};

type R<T> = std::result::Result<T, ResourceError>;
fn unavailable(_: impl std::fmt::Display) -> ResourceError {
    ResourceError::Unavailable
}
fn grant_hash(grant: &str) -> String {
    crate::digest(&format!("orkestr-v2-thread-ask-grant:{grant}"))
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> R<Uuid> {
    Uuid::parse_str(value).map_err(unavailable)
}
/// Bounded single-line label for composed texts.
fn label(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_control() || c == '"' { ' ' } else { c })
        .collect();
    let clean = clean.trim();
    let mut out: String = clean.chars().take(80).collect();
    if out.is_empty() {
        out.push_str("Assistant");
    }
    out
}
/// Runs whose agent can still take a tool result (a dispatched Deep run is
/// `starting` until the provider's first event is recorded).
const ACTIVE_RUN: &str = "('starting','running','cancel_requested')";
/// Per scheduler pass, so one pass stays well below its deadline.
const PASS_LIMIT: i64 = 16;

/// Grant holder's derived scope; never constructed from request fields.
struct Caller {
    owner: OwnerId,
    generation: i64,
    targets: Option<Vec<ConversationId>>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ThreadAskTick {
    /// Target Deep turns queued for new requests.
    pub queued: u32,
    /// Requests whose outcome became final.
    pub settled: u32,
    /// Outcomes returned to the asking conversation as a new input.
    pub returned: u32,
}

struct Observed {
    state: ThreadAskState,
    detail: Option<&'static str>,
    run: Option<String>,
    answer: Option<String>,
}

fn request_text(source: &str, ask: Uuid, text: &str) -> String {
    format!(
        "[Orkestr thread request {ask} from \"{source}\" (that thread's agent, not the owner)]\n\n{text}\n\n\
[Sent by the agent of another thread of the same owner through the audited Orkestr ask-thread tool. \
Answer it in this turn: your final reply is returned to \"{source}\" automatically and is not posted to \
this thread's chat. Use judgment with destructive, credential, financial or host-level requests; ask the \
owner when in doubt.]"
    )
}
fn reply_text(
    target: &str,
    ask: Uuid,
    outcome: &str,
    detail: Option<&str>,
    answer: Option<&str>,
) -> String {
    if outcome == "answered" {
        let answer = answer
            .filter(|a| !a.trim().is_empty())
            .unwrap_or("(The other thread finished without a text answer.)");
        format!(
            "[Orkestr thread answer {ask} from \"{target}\" (that thread's agent, not the owner)]\n\n{answer}\n\n\
[This answers the request this thread sent earlier with the ask-thread tool. Continue the original task \
with it and tell the owner the result if it matters to them.]"
        )
    } else {
        format!(
            "[Orkestr thread request {ask} to \"{target}\" was not answered: {}]\n\n\
[The other thread did not process this request. Tell the owner if the original task depends on it.]",
            detail.unwrap_or("failed")
        )
    }
}

async fn name(tx: &mut SqliteConnection, conversation: &str) -> R<String> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT name FROM conversation_directory WHERE conversation_id=?")
            .bind(conversation)
            .fetch_optional(tx)
            .await
            .map_err(unavailable)?;
    Ok(label(value.as_deref().unwrap_or("Assistant")))
}

async fn running_deep(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> R<Option<(String, String)>> {
    let row = sqlx::query("SELECT id,message_id FROM production_runs WHERE owner_id=? AND conversation_id=? AND role='deep' AND state IN ('starting','running') AND dispatch_state='delivery_unknown' ORDER BY rowid DESC LIMIT 1")
        .bind(owner.to_string()).bind(conversation.to_string())
        .fetch_optional(tx).await.map_err(unavailable)?;
    Ok(row.map(|r| (r.get("id"), r.get("message_id"))))
}

/// Exact Core facts for the target input; no provider output or caller claim.
async fn observe(tx: &mut SqliteConnection, ask: &SqliteRow) -> R<Observed> {
    let owner: String = ask.get("owner_id");
    let target: String = ask.get("target_conversation_id");
    let message: String = ask.get("input_message_id");
    let event: String = ask.get("input_event_id");
    let found = |state, detail| Observed {
        state,
        detail,
        run: None,
        answer: None,
    };
    let run = sqlx::query("SELECT id,state,dispatch_state FROM production_runs WHERE owner_id=? AND conversation_id=? AND message_id=? AND event_id=? AND role='deep' ORDER BY rowid DESC LIMIT 1")
        .bind(&owner).bind(&target).bind(&message).bind(&event)
        .fetch_optional(&mut *tx).await.map_err(unavailable)?;
    if let Some(run) = run {
        let id: String = run.get("id");
        // The accepted completion's answer is the last progress payload before it.
        let accepted = sqlx::query("SELECT (SELECT payload.text FROM production_payloads payload JOIN production_observations progress ON progress.event_id=payload.event_id AND progress.run_id=a.run_id AND progress.kind='progress' WHERE payload.run_id=a.run_id AND payload.owner_id=a.owner_id AND payload.conversation_id=a.conversation_id AND progress.run_sequence<o.run_sequence ORDER BY progress.run_sequence DESC LIMIT 1) AS text FROM production_acceptances a JOIN production_observations o ON o.event_id=a.completion_event_id AND o.run_id=a.run_id AND o.kind='completed_proposal' WHERE a.run_id=? AND a.owner_id=? AND a.conversation_id=?")
            .bind(&id).bind(&owner).bind(&target)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if let Some(accepted) = accepted {
            return Ok(Observed {
                state: ThreadAskState::Answered,
                detail: None,
                run: Some(id),
                answer: accepted.get("text"),
            });
        }
        let (state, detail) = match run.get::<&str, _>("state") {
            // Dispatched to the provider: the agent has the input.
            "starting" if run.get::<&str, _>("dispatch_state") == "delivery_unknown" => {
                (ThreadAskState::Running, None)
            }
            "starting" => (ThreadAskState::Admitted, Some("target_turn_starting")),
            "running" | "cancel_requested" => (ThreadAskState::Running, None),
            "awaiting_acceptance" => (ThreadAskState::Running, Some("awaiting_owner_review")),
            "failed" => (ThreadAskState::Failed, Some("target_turn_failed")),
            "blocked" => (ThreadAskState::Failed, Some("target_turn_blocked")),
            "cancelled" => (ThreadAskState::Failed, Some("target_turn_stopped")),
            "succeeded" => (ThreadAskState::Failed, Some("target_answer_not_accepted")),
            _ => return Err(ResourceError::Unavailable),
        };
        return Ok(Observed {
            state,
            detail,
            run: Some(id),
            answer: None,
        });
    }
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
            .bind(&event)
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
    if held != 0 {
        return Ok(found(
            ThreadAskState::Failed,
            Some("target_input_withdrawn"),
        ));
    }
    let released: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM execution_window_released_inputs WHERE event_id=?",
    )
    .bind(&event)
    .fetch_one(&mut *tx)
    .await
    .map_err(unavailable)?;
    if released != 0 {
        return Ok(found(ThreadAskState::Failed, Some("target_window_failed")));
    }
    let window: Option<String> = sqlx::query_scalar("SELECT w.state FROM execution_window_inputs i JOIN execution_windows w ON w.id=i.window_id WHERE i.event_id=?")
        .bind(&event).fetch_optional(&mut *tx).await.map_err(unavailable)?;
    match window.as_deref() {
        Some("closed") => return Ok(found(ThreadAskState::Failed, Some("target_window_closed"))),
        Some("reconciliation_required") => {
            return Ok(found(
                ThreadAskState::Admitted,
                Some("target_window_needs_reconciliation"),
            ))
        }
        Some(_) => return Ok(found(ThreadAskState::Admitted, None)),
        None => {}
    }
    let queued: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT state,withdrawal FROM execution_window_queue WHERE event_id=?")
            .bind(&event)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
    Ok(match queued {
        Some((state, _)) if state == "dispatched" => found(ThreadAskState::Admitted, None),
        Some((state, _)) if state == "withdrawn" => {
            found(ThreadAskState::Failed, Some("target_turn_refused"))
        }
        Some(_) => found(ThreadAskState::Sent, Some("waiting_for_target_capacity")),
        None => found(ThreadAskState::Sent, Some("waiting_for_target_turn")),
    })
}

fn settled_state(row: &SqliteRow) -> Option<ThreadAskState> {
    match row.get::<Option<&str>, _>("outcome") {
        Some("answered") => Some(ThreadAskState::Answered),
        Some(_) => Some(ThreadAskState::Failed),
        None => None,
    }
}
fn returned(row: &SqliteRow) -> Option<ThreadAskReturn> {
    match row.get::<Option<&str>, _>("return_path") {
        Some("tool_result") => Some(ThreadAskReturn::ToolResult),
        Some("input") => Some(ThreadAskReturn::Input),
        _ => None,
    }
}

async fn view(
    tx: &mut SqliteConnection,
    row: &SqliteRow,
    answer: Option<String>,
) -> R<ThreadAskView> {
    let target: String = row.get("target_conversation_id");
    let target_name = name(&mut *tx, &target).await?;
    let (state, detail) = match settled_state(row) {
        Some(state) => (state, row.get::<Option<String>, _>("outcome_detail")),
        None => {
            let observed = observe(&mut *tx, row).await?;
            (observed.state, observed.detail.map(str::to_owned))
        }
    };
    let returned = returned(row);
    Ok(ThreadAskView {
        ask_id: uuid(row.get("id"))?,
        request_key: row.get("request_key"),
        source_conversation_id: ConversationId(uuid(row.get("source_conversation_id"))?),
        target_conversation_id: ConversationId(uuid(&target)?),
        status_text: thread_ask_status_text(state, detail.as_deref(), &target_name, returned),
        target_name,
        state,
        detail,
        created_ms: row.get("created_ms"),
        settled_ms: row.get("settled_ms"),
        returned,
        reply_message_id: row
            .get::<Option<String>, _>("reply_message_id")
            .map(|id| uuid(&id))
            .transpose()?,
        answer,
    })
}

async fn ask_row(tx: &mut SqliteConnection, id: &str) -> R<SqliteRow> {
    sqlx::query("SELECT * FROM thread_asks WHERE id=?")
        .bind(id)
        .fetch_optional(tx)
        .await
        .map_err(unavailable)?
        .ok_or(ResourceError::NotFound)
}

/// Persist a final observation once; a settled row is never re-decided.
async fn settle(tx: &mut SqliteConnection, row: &SqliteRow) -> R<bool> {
    if row.get::<Option<String>, _>("outcome").is_some() {
        return Ok(false);
    }
    let observed = observe(&mut *tx, row).await?;
    if !observed.state.terminal() {
        return Ok(false);
    }
    let outcome = if observed.state == ThreadAskState::Answered {
        "answered"
    } else {
        "failed"
    };
    let changed = sqlx::query("UPDATE thread_asks SET outcome=?,outcome_detail=?,target_run_id=?,answer_text=?,settled_ms=? WHERE id=? AND outcome IS NULL")
        .bind(outcome).bind(observed.detail).bind(observed.run).bind(observed.answer)
        .bind(now_ms()).bind(row.get::<String, _>("id"))
        .execute(tx).await.map_err(unavailable)?.rows_affected();
    Ok(changed == 1)
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    source: &ConversationId,
    run: Option<&str>,
    generation: i64,
    request: &ThreadAskRequest,
    ask: Option<&str>,
    outcome: &str,
) -> R<()> {
    sqlx::query("INSERT INTO thread_ask_audit(owner_id,source_conversation_id,source_run_id,grant_generation,target_conversation_id,request_key,text_digest,ask_id,outcome,at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(source.to_string()).bind(run).bind(generation)
        .bind(request.target_conversation_id.to_string()).bind(&request.request_key)
        .bind(crate::digest(&request.text)).bind(ask).bind(outcome).bind(now_ms())
        .execute(tx).await.map_err(unavailable)?;
    Ok(())
}

fn grant_of(conversation: &ConversationId, row: Option<&SqliteRow>) -> R<ThreadAskGrant> {
    Ok(match row {
        None => ThreadAskGrant {
            conversation_id: conversation.clone(),
            issued: false,
            generation: 0,
            targets: None,
        },
        Some(row) => ThreadAskGrant {
            conversation_id: conversation.clone(),
            issued: row.get::<Option<String>, _>("grant_hash").is_some(),
            generation: row.get("generation"),
            targets: row
                .get::<Option<String>, _>("targets_json")
                .map(|t| serde_json::from_str(&t).map_err(unavailable))
                .transpose()?,
        },
    })
}
async fn grant_row(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
) -> R<Option<SqliteRow>> {
    sqlx::query("SELECT * FROM thread_ask_grants WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(tx)
        .await
        .map_err(unavailable)
}
async fn unavailable_target(tx: &mut SqliteConnection, owner: &OwnerId, target: &str) -> R<bool> {
    let n: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM restricted_threads WHERE conversation_id=?1 AND enabled=1)+(SELECT count(*) FROM whatsapp_chat_provisions WHERE owner_id=?2 AND conversation_id=?1 AND archived=1)")
        .bind(target).bind(owner.to_string()).fetch_one(tx).await.map_err(unavailable)?;
    Ok(n != 0)
}

impl Store {
    async fn thread_ask_scope(
        &self,
        grant: &str,
        conversation: &ConversationId,
        write: bool,
    ) -> R<(Transaction<'_, Sqlite>, Caller)> {
        if self.authority.is_some() || !hex64(grant) {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        let row = sqlx::query("SELECT owner_id,generation,targets_json FROM thread_ask_grants WHERE conversation_id=? AND grant_hash=?")
            .bind(conversation.to_string()).bind(grant_hash(grant))
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
            .ok_or(ResourceError::Unauthorized)?;
        let owner = OwnerId(uuid(row.get("owner_id")).map_err(|_| ResourceError::Unauthorized)?);
        owned(&mut tx, &owner, conversation).await?;
        let targets = row
            .get::<Option<String>, _>("targets_json")
            .map(|t| serde_json::from_str(&t).map_err(unavailable))
            .transpose()?;
        Ok((
            tx,
            Caller {
                owner,
                generation: row.get("generation"),
                targets,
            },
        ))
    }

    // ---- owner ---------------------------------------------------------------

    pub async fn thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<ThreadAskGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let row = grant_row(&mut tx, conversation).await?;
        let result = grant_of(conversation, row.as_ref())?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Issue or rotate the conversation's grant. Shown once; the hash is stored.
    pub async fn issue_thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &ThreadAskGrantRequest,
    ) -> R<ThreadAskGrantIssued> {
        if !request.is_valid(conversation) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        if unavailable_target(&mut tx, owner, &conversation.to_string()).await? {
            return Err(ResourceError::Conflict(
                "thread_ask_conversation_unavailable",
            ));
        }
        for target in request.targets.iter().flatten() {
            if owned(&mut tx, owner, target).await.is_err() {
                return Err(ResourceError::Conflict("thread_ask_target_not_found"));
            }
        }
        let grant = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let targets = request
            .targets
            .as_ref()
            .map(|t| serde_json::to_string(t).map_err(unavailable))
            .transpose()?;
        sqlx::query("INSERT INTO thread_ask_grants(conversation_id,owner_id,grant_hash,generation,targets_json,issued_ms) VALUES(?,?,?,1,?,?) ON CONFLICT(conversation_id) DO UPDATE SET grant_hash=excluded.grant_hash,generation=thread_ask_grants.generation+1,targets_json=excluded.targets_json,issued_ms=excluded.issued_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(grant_hash(&grant))
            .bind(targets).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation).await?;
        let binding = grant_of(conversation, row.as_ref())?;
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskGrantIssued { grant, binding })
    }

    pub async fn revoke_thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<ThreadAskGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        sqlx::query("UPDATE thread_ask_grants SET grant_hash=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::NotFound)?;
        let result = grant_of(conversation, Some(&row))?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Owner-visible requests sent from or received by this conversation,
    /// newest first. Answers are not repeated here.
    pub async fn thread_asks_for_owner(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limit: u16,
    ) -> R<ThreadAskList> {
        if !(1..=50).contains(&limit) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let rows = sqlx::query("SELECT * FROM thread_asks WHERE owner_id=?1 AND (source_conversation_id=?2 OR target_conversation_id=?2) ORDER BY created_ms DESC,rowid DESC LIMIT ?3")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut asks = Vec::with_capacity(rows.len());
        for row in &rows {
            asks.push(view(&mut tx, row, None).await?);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskList { asks })
    }

    // ---- grant holder (the asking conversation's agent) -------------------------

    /// Conversations this grant may ask, with their names.
    pub async fn thread_ask_targets(
        &self,
        grant: &str,
        conversation: &ConversationId,
    ) -> R<Vec<ThreadAskTarget>> {
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT c.id,coalesce(d.name,'Assistant') FROM conversations c LEFT JOIN conversation_directory d ON d.conversation_id=c.id WHERE c.owner_id=?1 AND c.id!=?2 AND NOT EXISTS(SELECT 1 FROM restricted_threads r WHERE r.conversation_id=c.id AND r.enabled=1) AND NOT EXISTS(SELECT 1 FROM whatsapp_chat_provisions p WHERE p.owner_id=c.owner_id AND p.conversation_id=c.id AND p.archived=1) ORDER BY d.name,c.id LIMIT 500")
            .bind(caller.owner.to_string()).bind(conversation.to_string())
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        rows.into_iter()
            .map(|(id, name)| {
                Ok(ThreadAskTarget {
                    conversation_id: ConversationId(uuid(&id)?),
                    name: label(&name),
                })
            })
            .filter(|t: &R<ThreadAskTarget>| {
                t.as_ref().map_or(true, |t| {
                    caller
                        .targets
                        .as_ref()
                        .is_none_or(|allowed| allowed.contains(&t.conversation_id))
                })
            })
            .collect()
    }

    /// Record one request and admit it as the target's attributed input.
    /// Refusals are audited and change nothing else.
    pub async fn create_thread_ask(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: &ThreadAskRequest,
    ) -> R<ThreadAskReceipt> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, true).await?;
        let owner = caller.owner.clone();
        let target = request.target_conversation_id.to_string();
        let digest = crate::digest(&request.text);
        if let Some(row) = sqlx::query("SELECT * FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)? {
            if row.get::<String, _>("target_conversation_id") != target
                || row.get::<String, _>("text_digest") != digest
            {
                audit(&mut tx, &owner, conversation, None, caller.generation, request, None, "thread_ask_conflict").await?;
                tx.commit().await.map_err(unavailable)?;
                return Err(ResourceError::Conflict("thread_ask_conflict"));
            }
            let ask = view(&mut tx, &row, None).await?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(ThreadAskReceipt { created: false, ask });
        }
        let running = running_deep(&mut tx, &owner, conversation).await?;
        let refusal = if request.target_conversation_id == *conversation {
            Some("thread_ask_self")
        } else if caller
            .targets
            .as_ref()
            .is_some_and(|t| !t.contains(&request.target_conversation_id))
        {
            Some("thread_ask_target_not_allowed")
        } else if owned(&mut tx, &owner, &request.target_conversation_id)
            .await
            .is_err()
        {
            // Another owner's conversation is indistinguishable from none.
            Some("thread_ask_target_not_found")
        } else if unavailable_target(&mut tx, &owner, &target).await? {
            Some("thread_ask_target_unavailable")
        } else if running.is_none() {
            Some("thread_ask_no_running_turn")
        } else {
            None
        };
        let depth = match &running {
            Some((_, message)) => {
                let parent: Option<(i64, bool)> = sqlx::query_as("SELECT depth,input_message_id=?1 FROM thread_asks WHERE owner_id=?2 AND (input_message_id=?1 OR reply_message_id=?1)")
                    .bind(message).bind(owner.to_string())
                    .fetch_optional(&mut *tx).await.map_err(unavailable)?;
                match parent {
                    Some((depth, true)) => depth + 1,
                    Some((depth, false)) => depth,
                    None => 0,
                }
            }
            None => 0,
        };
        let open: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_asks WHERE owner_id=? AND source_conversation_id=? AND return_path IS NULL")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let hourly: i64 = sqlx::query_scalar("SELECT count(*) FROM thread_ask_audit WHERE source_conversation_id=? AND outcome='accepted' AND at_ms>?")
            .bind(conversation.to_string()).bind(now_ms() - 3_600_000)
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        let refusal = refusal.or(if depth > THREAD_ASK_MAX_DEPTH {
            Some("thread_ask_chain_too_deep")
        } else if open >= THREAD_ASK_OPEN_MAX || hourly >= THREAD_ASK_HOURLY_MAX {
            Some("thread_ask_rate_limited")
        } else {
            None
        });
        let run = running.as_ref().map(|(run, _)| run.as_str());
        if let Some(code) = refusal {
            audit(
                &mut tx,
                &owner,
                conversation,
                run,
                caller.generation,
                request,
                None,
                code,
            )
            .await?;
            tx.commit().await.map_err(unavailable)?;
            return Err(ResourceError::Conflict(code));
        }
        let run = run.ok_or(ResourceError::Unavailable)?.to_owned();
        let ask = Uuid::new_v4();
        let source_name = name(&mut tx, &conversation.to_string()).await?;
        let input = MessageInput {
            client_message_id: format!("thread-ask:{ask}"),
            text: request_text(&source_name, ask, &request.text),
        };
        let admitted = crate::intake::admit_in_transaction(
            &mut tx,
            &owner,
            &request.target_conversation_id,
            &input,
        )
        .await
        .map_err(|_| ResourceError::Unavailable)?;
        if admitted.duplicate {
            return Err(ResourceError::Unavailable);
        }
        sqlx::query("INSERT INTO thread_asks(id,owner_id,source_conversation_id,source_run_id,grant_generation,request_key,target_conversation_id,text_digest,depth,input_message_id,input_event_id,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(ask.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&run)
            .bind(caller.generation).bind(&request.request_key).bind(&target).bind(&digest).bind(depth)
            .bind(admitted.receipt.message_id.to_string()).bind(admitted.receipt.event_id.to_string())
            .bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        audit(
            &mut tx,
            &owner,
            conversation,
            Some(&run),
            caller.generation,
            request,
            Some(&ask.to_string()),
            "accepted",
        )
        .await?;
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let ask = view(&mut tx, &row, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskReceipt { created: true, ask })
    }

    /// Read-only status of one request sent by this conversation.
    pub async fn thread_ask_status(
        &self,
        grant: &str,
        conversation: &ConversationId,
        ask: Uuid,
    ) -> R<ThreadAskView> {
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, false).await?;
        let row = sqlx::query(
            "SELECT * FROM thread_asks WHERE id=? AND owner_id=? AND source_conversation_id=?",
        )
        .bind(ask.to_string())
        .bind(caller.owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(ResourceError::NotFound)?;
        let result = view(&mut tx, &row, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Return a settled outcome to the running asking turn, at most once. If
    /// the outcome was already returned (here or as an input), the view says
    /// how and carries no answer.
    pub async fn collect_thread_ask(
        &self,
        grant: &str,
        conversation: &ConversationId,
        ask: Uuid,
    ) -> R<ThreadAskView> {
        let (mut tx, caller) = self.thread_ask_scope(grant, conversation, true).await?;
        let row = sqlx::query(
            "SELECT * FROM thread_asks WHERE id=? AND owner_id=? AND source_conversation_id=?",
        )
        .bind(ask.to_string())
        .bind(caller.owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(ResourceError::NotFound)?;
        if running_deep(&mut tx, &caller.owner, conversation)
            .await?
            .is_none()
        {
            return Err(ResourceError::Conflict("thread_ask_no_running_turn"));
        }
        settle(&mut tx, &row).await?;
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let mut answer = None;
        if row.get::<Option<String>, _>("outcome").is_some() && returned(&row).is_none() {
            let changed = sqlx::query("UPDATE thread_asks SET return_path='tool_result',returned_ms=? WHERE id=? AND return_path IS NULL")
                .bind(now_ms()).bind(ask.to_string())
                .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
            if changed == 1 && row.get::<Option<&str>, _>("outcome") == Some("answered") {
                answer = Some(
                    row.get::<Option<String>, _>("answer_text")
                        .unwrap_or_else(|| {
                            "(The other thread finished without a text answer.)".into()
                        }),
                );
            }
        }
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let result = view(&mut tx, &row, answer).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    // ---- trusted scheduler ----------------------------------------------------

    /// One bounded pass of the trusted local scheduler (same authority as timer
    /// occurrences): queue target turns (only with a window dispatcher), settle
    /// outcomes from Core facts, and return outcomes of ended asking turns as
    /// one attributed input each. Every item commits on its own.
    pub async fn advance_thread_asks(&self, queue_window: bool) -> Result<ThreadAskTick> {
        let context = self.context()?;
        let owner = context.owner.clone();
        let mut tick = ThreadAskTick::default();
        let mut tx = self.pool.begin().await.map_err(db)?;
        context.validate(&mut tx).await?;
        let pending: Vec<String> = if queue_window {
            sqlx::query_scalar("SELECT id FROM thread_asks WHERE owner_id=? AND outcome IS NULL AND window_queued_ms IS NULL ORDER BY created_ms,rowid LIMIT ?")
                .bind(owner.to_string()).bind(PASS_LIMIT).fetch_all(&mut *tx).await.map_err(db)?
        } else {
            Vec::new()
        };
        let open: Vec<String> = sqlx::query_scalar("SELECT id FROM thread_asks WHERE owner_id=? AND outcome IS NULL ORDER BY created_ms,rowid LIMIT ?")
            .bind(owner.to_string()).bind(PASS_LIMIT * 2).fetch_all(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        for id in pending {
            match self.queue_thread_ask(&owner, &id).await {
                Ok(true) => tick.queued += 1,
                Ok(false) => {}
                Err(RuntimeStoreError::Busy) => break,
                Err(error) => return Err(error),
            }
        }
        for id in open {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            context.validate(&mut tx).await?;
            let row = ask_row(&mut tx, &id)
                .await
                .map_err(|_| RuntimeStoreError::Unavailable)?;
            if settle(&mut tx, &row)
                .await
                .map_err(|_| RuntimeStoreError::Unavailable)?
            {
                tick.settled += 1;
            }
            tx.commit().await.map_err(db)?;
        }
        // Listed after settling, so an outcome settled in this pass returns now.
        let mut tx = self.pool.begin().await.map_err(db)?;
        context.validate(&mut tx).await?;
        let ended: Vec<String> = sqlx::query_scalar(&format!("SELECT a.id FROM thread_asks a WHERE a.owner_id=? AND a.outcome IS NOT NULL AND a.return_path IS NULL AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.id=a.source_run_id AND r.state IN {ACTIVE_RUN}) ORDER BY a.settled_ms,a.rowid LIMIT ?"))
            .bind(owner.to_string()).bind(PASS_LIMIT).fetch_all(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        for id in ended {
            match self.return_thread_ask(&owner, &id, queue_window).await {
                Ok(true) => tick.returned += 1,
                Ok(false) => {}
                Err(RuntimeStoreError::Busy) => break,
                Err(error) => return Err(error),
            }
        }
        Ok(tick)
    }

    async fn queue_thread_ask(&self, owner: &OwnerId, id: &str) -> Result<bool> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let row = ask_row(&mut tx, id)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        if row.get::<Option<i64>, _>("window_queued_ms").is_some()
            || row.get::<Option<String>, _>("outcome").is_some()
        {
            return Ok(false);
        }
        let event: String = row.get("input_event_id");
        let elsewhere: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM execution_window_inputs WHERE event_id=?1)+(SELECT count(*) FROM execution_window_queue WHERE event_id=?1)")
            .bind(&event).fetch_one(&mut *tx).await.map_err(db)?;
        let mut queued = false;
        if elsewhere == 0 {
            match execution_window::enqueue_trusted_intent(
                &mut tx,
                owner,
                &ConversationId(
                    uuid(row.get("target_conversation_id"))
                        .map_err(|_| RuntimeStoreError::Unavailable)?,
                ),
                MessageId(
                    uuid(row.get("input_message_id"))
                        .map_err(|_| RuntimeStoreError::Unavailable)?,
                ),
                EventId(uuid(&event).map_err(|_| RuntimeStoreError::Unavailable)?),
                &format!("thread-ask:{id}"),
                format!("thread-ask-window:{event}"),
            )
            .await
            {
                Ok(()) => queued = true,
                Err(RuntimeStoreError::Busy) => return Err(RuntimeStoreError::Busy),
                // Held, retired or already consumed: settlement reports it.
                Err(RuntimeStoreError::Fenced | RuntimeStoreError::Conflict) => {}
                Err(error) => return Err(error),
            }
        }
        sqlx::query(
            "UPDATE thread_asks SET window_queued_ms=? WHERE id=? AND window_queued_ms IS NULL",
        )
        .bind(now_ms())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(queued)
    }

    async fn return_thread_ask(
        &self,
        owner: &OwnerId,
        id: &str,
        queue_window: bool,
    ) -> Result<bool> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        let row = ask_row(&mut tx, id)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        let active: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM production_runs WHERE id=? AND state IN {ACTIVE_RUN}"
        ))
        .bind(row.get::<String, _>("source_run_id"))
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let outcome: Option<String> = row.get("outcome");
        let Some(outcome) = outcome.filter(|_| returned(&row).is_none() && active == 0) else {
            return Ok(false);
        };
        let source = ConversationId(
            uuid(row.get("source_conversation_id")).map_err(|_| RuntimeStoreError::Unavailable)?,
        );
        let target_name = name(&mut tx, row.get("target_conversation_id"))
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        let ask = uuid(id).map_err(|_| RuntimeStoreError::Unavailable)?;
        let input = MessageInput {
            client_message_id: format!("thread-ask-reply:{id}"),
            text: reply_text(
                &target_name,
                ask,
                &outcome,
                row.get::<Option<&str>, _>("outcome_detail"),
                row.get::<Option<&str>, _>("answer_text"),
            ),
        };
        let admitted = crate::intake::admit_in_transaction(&mut tx, owner, &source, &input)
            .await
            .map_err(|_| RuntimeStoreError::Conflict)?;
        if admitted.duplicate {
            return Err(RuntimeStoreError::Conflict);
        }
        let changed = sqlx::query("UPDATE thread_asks SET return_path='input',reply_message_id=?,reply_event_id=?,returned_ms=? WHERE id=? AND return_path IS NULL")
            .bind(admitted.receipt.message_id.to_string()).bind(admitted.receipt.event_id.to_string())
            .bind(now_ms()).bind(id)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        if queue_window {
            execution_window::enqueue_trusted_intent(
                &mut tx,
                owner,
                &source,
                admitted.receipt.message_id.clone(),
                admitted.receipt.event_id.clone(),
                &input.client_message_id,
                format!("thread-ask-window:{}", admitted.receipt.event_id.0),
            )
            .await?;
        }
        tx.commit().await.map_err(db)?;
        Ok(true)
    }
}

#[cfg(test)]
#[path = "thread_asks_tests.rs"]
mod tests;
