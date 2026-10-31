//! Deep burst grouping: owner inputs that queued while a Deep turn was busy
//! are answered together by the next Deep turn instead of one turn each.
//!
//! The group is decided once, inside the Deep admission transaction that
//! consumes the claimed head input: every grouped input is consumed by that
//! same run (`reasoning_inbox.admitted_run_id`) in that one commit. A crash
//! before the commit consumes nothing, so the head's claim lapses and the
//! next Deep turn takes the whole burst again, exactly once. After the commit
//! no input of the group can be claimed again: it is never processed twice,
//! and the run's own outcome (accepted, failed, stopped) settles all of them.
//!
//! Only verified owner chat inputs are grouped (`message_authors.author =
//! 'owner'`): timer occurrences, members, local agents, steering messages and
//! thread asks keep their own turns, and a group never runs past one of
//! them (arrival order is kept). Held inputs stay held and are skipped, as
//! the claim gate skips them; a group never runs past an input that has not
//! joined the current window yet. A lone input, a head that did not wait
//! behind a busy Deep turn and was not part of a burst, or the owner switch
//! `deep_grouping` set off, keep the single-input turn unchanged.
//!
//! Split messages (a burst): WhatsApp delivers one thought typed as several
//! messages ("Say :", "Field notes.", ":)") within a second or two.
//! With a quiet window configured (`Store::with_deep_burst_quiet_ms`, the
//! server default is DEFAULT_DEEP_BURST_QUIET_MS), the canonical Deep claim
//! of a verified owner chat head waits until no further owner message of its
//! burst arrived for that long (`settling`, at most 4x the window after the
//! head arrived), and the burst then forms one group even when Deep was idle:
//! each member arrived at most the quiet window after the previous one. Fast
//! is untouched (it never reads the Deep inbox): every message still gets its
//! own Fast reply at once.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, RunId};
use sqlx::sqlite::SqliteRow;

/// At most this many inputs (the head included) in one grouped Deep turn.
pub const DEEP_GROUP_MAX_INPUTS: usize = 12;
/// Owner text bytes of one group, the head included. Claude bounds a turn
/// at 32 KiB; the group note, numbering and handoff context need the rest.
pub const DEEP_GROUP_TEXT_BUDGET: usize = 20 * 1024;

/// Default quiet window of a Deep burst (ms): one split message arrives
/// within about a second; 2.5 s leaves room for a slow phone.
pub const DEFAULT_DEEP_BURST_QUIET_MS: i64 = 2_500;
/// Upper bound of a configured quiet window (ms).
pub const MAX_DEEP_BURST_QUIET_MS: i64 = 10_000;

/// A continuous stream never holds its head's Deep turn longer than this.
fn burst_max_wait_ms(quiet_ms: i64) -> i64 {
    quiet_ms.saturating_mul(4)
}

/// Arrival time (ms since the epoch, Core's clock) of inbox row `i`.
const ARRIVED_MS: &str = "(SELECT CAST((julianday(e.occurred_at)-2440587.5)*86400000 AS INTEGER) FROM events e WHERE e.id=i.event_id)";

/// The input is a verified owner chat message with its own ordinary turn.
const OWNER_INPUT: &str = "EXISTS(SELECT 1 FROM message_authors a WHERE a.message_id=i.message_id AND a.author='owner') AND NOT EXISTS(SELECT 1 FROM dormant_timer_inputs t WHERE t.event_id=i.event_id) AND NOT EXISTS(SELECT 1 FROM production_steering s WHERE s.event_id=i.event_id) AND NOT EXISTS(SELECT 1 FROM thread_asks q WHERE q.input_event_id=i.event_id)";

/// The queued inputs behind `head`, in arrival order, with what grouping
/// needs to know about each (see `form`).
async fn behind(
    tx: &mut SqliteConnection,
    conversation: &str,
    head: i64,
    window: Option<&str>,
    slots: bool,
) -> Result<Vec<SqliteRow>> {
    // A row a parallel slot claimed is that slot's (consumed at its own
    // admission): skipped like a held row, never grouped and never a stop.
    let slot_claimed = if slots {
        super::parallel_deep::claimed_by_slot("i")
    } else {
        "0".to_owned()
    };
    sqlx::query(&format!("SELECT i.sequence,i.state,({slot_claimed}) AS slot_claimed,length(CAST(m.text AS BLOB)) AS bytes,({OWNER_INPUT}) AS owner_input,EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) AS held,(?3 IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=?3 AND wi.event_id=i.event_id)) AS scoped,coalesce({ARRIVED_MS},0) AS arrived_ms FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id WHERE i.conversation_id=?1 AND i.sequence>?2 AND i.state IN ('queued','claimed') ORDER BY i.sequence LIMIT 64"))
        .bind(conversation).bind(head).bind(window).fetch_all(&mut *tx).await.map_err(db)
}

/// Byte length and arrival time of `head` when it is a verified owner chat
/// input, else None (it never groups and never waits for a burst).
async fn owner_head(
    tx: &mut SqliteConnection,
    conversation: &str,
    head: i64,
) -> Result<Option<(i64, i64)>> {
    let row = sqlx::query(&format!("SELECT length(CAST(m.text AS BLOB)) AS bytes,coalesce({ARRIVED_MS},0) AS arrived_ms FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id WHERE i.conversation_id=? AND i.sequence=? AND {OWNER_INPUT}"))
        .bind(conversation).bind(head).fetch_optional(&mut *tx).await.map_err(db)?;
    Ok(row.map(|row| (row.get("bytes"), row.get("arrived_ms"))))
}

/// Whether the canonical Deep claim of the queued head at `head` waits for
/// the rest of its owner burst: an owner message of the burst (the head or
/// one that joins it) arrived less than `quiet_ms` ago, and the head arrived
/// less than 4x `quiet_ms` ago. Never for a non-owner head, with the window
/// off (0) or with the owner switch `deep_grouping` off.
pub(crate) async fn settling(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
    head: i64,
    window: Option<&str>,
    quiet_ms: i64,
    now_ms: i64,
) -> Result<bool> {
    if quiet_ms <= 0 {
        return Ok(false);
    }
    let conversation = conversation.to_string();
    if !crate::conversation_resources::settings::deep_grouping(tx, &conversation)
        .await
        .map_err(db)?
    {
        return Ok(false);
    }
    let Some((_, head_at)) = owner_head(tx, &conversation, head).await? else {
        return Ok(false);
    };
    if now_ms.saturating_sub(head_at) >= burst_max_wait_ms(quiet_ms) {
        return Ok(false);
    }
    let slots = super::parallel_deep::present(tx).await?;
    let mut newest = head_at;
    let mut count = 1;
    for row in behind(tx, &conversation, head, window, slots).await? {
        if count >= DEEP_GROUP_MAX_INPUTS {
            break;
        }
        if row.get::<bool, _>("held") || row.get::<bool, _>("slot_claimed") {
            continue;
        }
        let arrived: i64 = row.get("arrived_ms");
        if !row.get::<bool, _>("scoped")
            || row.get::<&str, _>("state") != "queued"
            || !row.get::<bool, _>("owner_input")
            || arrived.saturating_sub(newest) > quiet_ms
        {
            break;
        }
        newest = newest.max(arrived);
        count += 1;
    }
    Ok(now_ms.saturating_sub(newest) < quiet_ms)
}

/// Consume, for the Deep run `run` that just consumed the claimed head
/// input at `head`, every owner input queued behind it that joins its turn:
/// those that queued while an earlier Deep turn was busy, and those of the
/// head's own burst (each at most `quiet_ms` after the previous one; 0 = no
/// burst grouping). Called only inside that admission transaction. Returns
/// the number of inputs consumed in addition to the head.
pub(super) async fn form(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
    head: i64,
    window: Option<&str>,
    run: &str,
    quiet_ms: i64,
) -> Result<usize> {
    let conversation = conversation.to_string();
    // A read-only parallel Deep slot answers exactly its own input: only the
    // canonical writer ever groups (docs/v2/parallel-deep.md).
    let session: String = sqlx::query_scalar("SELECT session_id FROM production_runs WHERE id=?")
        .bind(run)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if super::parallel_deep::is_slot(tx, &session).await? {
        return Ok(0);
    }
    if !crate::conversation_resources::settings::deep_grouping(tx, &conversation)
        .await
        .map_err(db)?
    {
        return Ok(0);
    }
    let Some((head_bytes, head_at)) = owner_head(tx, &conversation, head).await? else {
        return Ok(0);
    };
    // Deep was busy when the head arrived: the conversation's previous Deep
    // run (of an earlier input) still recorded progress, its proposal, its
    // acceptance or a stop after the head's own journal sequence. The last
    // such event bounds the group: a member must also have arrived while that
    // run was still busy, so an input admitted after Deep went idle (a
    // deadline continuation or re-admission of an older adapter row, or a
    // new task sent once the turn ended) keeps its own turn.
    // Only the canonical lineage's runs count: a parallel slot's activity
    // never makes the writer look busy.
    let slots = super::parallel_deep::present(tx).await?;
    let canonical = if slots {
        format!(" AND {}", super::parallel_deep::canonical_run("p"))
    } else {
        String::new()
    };
    let busy_through: Option<i64> = sqlx::query_scalar(&format!("SELECT max(last) FROM (SELECT max(coalesce((SELECT max(e.sequence) FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=p.id),0),coalesce((SELECT max(e.sequence) FROM production_acceptances a JOIN events e ON e.id=a.event_id WHERE a.run_id=p.id),0),coalesce((SELECT max(e.sequence) FROM production_cancellations c JOIN events e ON e.id=c.event_id WHERE c.run_id=p.id),0)) AS last FROM production_runs p WHERE p.conversation_id=?1 AND p.role='deep' AND p.id!=?3 AND p.scope_sequence<?2{canonical}) WHERE last>?2"))
        .bind(&conversation).bind(head).bind(run).fetch_one(&mut *tx).await.map_err(db)?;
    if busy_through.is_none() && quiet_ms <= 0 {
        return Ok(0);
    }
    let rows = behind(tx, &conversation, head, window, slots).await?;
    let mut bytes = usize::try_from(head_bytes).map_err(db)?;
    let mut members = Vec::new();
    // Arrival of the last input of the group so far: the burst chain.
    let mut previous = head_at;
    for row in rows {
        let arrived: i64 = row.get("arrived_ms");
        let queued_while_busy =
            busy_through.is_some_and(|busy| row.get::<i64, _>("sequence") < busy);
        let same_burst = quiet_ms > 0 && arrived.saturating_sub(previous) <= quiet_ms;
        if members.len() + 1 >= DEEP_GROUP_MAX_INPUTS || !(queued_while_busy || same_burst) {
            break; // Arrived after Deep went idle, not split from the head: its own turn.
        }
        if row.get::<bool, _>("held") {
            continue; // Held per input; released later, it queues on its own.
        }
        if row.get::<bool, _>("slot_claimed") {
            continue; // A read-only parallel slot answers it.
        }
        if !row.get::<bool, _>("scoped")
            || row.get::<&str, _>("state") != "queued"
            || !row.get::<bool, _>("owner_input")
        {
            break; // Never run past a timer, member, steer or unjoined input.
        }
        let size = usize::try_from(row.get::<i64, _>("bytes")).map_err(db)?;
        if bytes + size > DEEP_GROUP_TEXT_BUDGET {
            break; // The rest waits for the next turn, in order.
        }
        bytes += size;
        members.push(row.get::<i64, _>("sequence"));
        previous = previous.max(arrived);
    }
    for sequence in &members {
        let changed = sqlx::query("UPDATE reasoning_inbox SET state='consumed',admitted_run_id=? WHERE conversation_id=? AND sequence=? AND state='queued'")
            .bind(run).bind(&conversation).bind(sequence)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
    }
    Ok(members.len())
}

/// The inputs of a grouped Deep run, in arrival order (head first). Empty
/// unless the run consumed two or more inputs.
async fn members(
    conn: &mut SqliteConnection,
    conversation: &str,
    head: i64,
    run: &str,
) -> Result<Vec<SqliteRow>> {
    let rows = sqlx::query(&format!("SELECT i.sequence,i.message_id,i.event_id,m.text,m.request_key,coalesce({ARRIVED_MS},0) AS arrived_ms FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id WHERE i.conversation_id=? AND i.sequence>=? AND i.admitted_run_id=? AND i.state='consumed' ORDER BY i.sequence LIMIT ?"))
        .bind(conversation).bind(head).bind(run).bind(DEEP_GROUP_MAX_INPUTS as i64 + 1)
        .fetch_all(&mut *conn).await.map_err(db)?;
    Ok(if rows.len() >= 2 { rows } else { Vec::new() })
}

/// The Deep turn text of a grouped run, or None for a single-input run.
pub(super) async fn text(conn: &mut SqliteConnection, run: &SqliteRow) -> Result<Option<String>> {
    if run.get::<&str, _>("role") != "deep" {
        return Ok(None);
    }
    let rows = members(
        conn,
        run.get("conversation_id"),
        run.get("scope_sequence"),
        run.get("id"),
    )
    .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let items: Vec<(i64, String, String)> = rows
        .iter()
        .map(|row| (row.get("sequence"), row.get("message_id"), row.get("text")))
        .collect();
    // One split message: every part followed the previous one within the
    // default quiet window. Decided from the stored arrivals only (never
    // from configuration), so a replayed dispatch renders the same text.
    let arrivals: Vec<i64> = rows.iter().map(|row| row.get("arrived_ms")).collect();
    let split = arrivals
        .windows(2)
        .all(|pair| (0..=DEFAULT_DEEP_BURST_QUIET_MS).contains(&(pair[1] - pair[0])));
    Ok(Some(render(&items, split)))
}

/// Header of one owner message WhatsApp split into parts; `%N%` is the
/// number of parts.
const SPLIT_NOTE: &str = "[Split message: the owner sent this as %N% WhatsApp messages in quick succession. They are listed below in order, each with its source reference. Read them together as one message and answer it once, covering all of it.]";

/// Header of a grouped Deep turn; `%N%` is the number of items.
const GROUP_NOTE: &str = "[Grouped turn: %N% owner messages arrived while you were busy with the previous turn. They are listed below as a numbered list in arrival order, each with its source reference. Answer every item explicitly in this one reply: address each by its number, in order (1. to %N%.). Do not skip any item; if one needs no answer, or a later item replaces it, say so in one line under its number.]";

/// Numbered items in arrival order (`split`: the parts of one split
/// message, else separate messages to answer one by one). The adapter's leading chat-rules line,
/// when the items share it, is given once at the top (it stays the first
/// line, as on a single-input turn).
pub(super) fn render(items: &[(i64, String, String)], split: bool) -> String {
    let rules = items
        .first()
        .and_then(|(_, _, text)| super::fast_rules::leading_line(text))
        .map(str::to_owned);
    let mut out = String::new();
    if let Some(line) = &rules {
        out.push_str(line);
        out.push_str("\n\n");
    }
    let note = if split { SPLIT_NOTE } else { GROUP_NOTE };
    out.push_str(&note.replace("%N%", &items.len().to_string()));
    for (index, (sequence, message, text)) in items.iter().enumerate() {
        let body = match &rules {
            Some(line) if super::fast_rules::leading_line(text) == Some(line.as_str()) => {
                text[line.len()..].trim_start_matches('\n')
            }
            _ => text.as_str(),
        };
        out.push_str(&format!(
            "\n\n{}. [source: message {message}, sequence {sequence}]\n{}",
            index + 1,
            body.trim_end()
        ));
    }
    out
}

impl Store {
    /// The inputs one exact Deep run answers, in arrival order, when it is a
    /// grouped turn (two or more); empty for a single-input run or a run of
    /// another conversation. Same browser-session authentication as the
    /// exact-run status. Each entry: message id, event id, and the intake
    /// request key (the channel's own client message id).
    pub async fn deep_run_group_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
    ) -> Result<Vec<(MessageId, EventId, String)>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let head: Option<i64> = sqlx::query_scalar("SELECT scope_sequence FROM production_runs WHERE id=? AND owner_id=? AND conversation_id=? AND role='deep'")
            .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(head) = head else {
            return Ok(Vec::new());
        };
        let rows = members(&mut tx, &conversation.to_string(), head, &run.to_string()).await?;
        tx.commit().await.map_err(db)?;
        rows.iter()
            .map(|row| {
                Ok((
                    MessageId(Uuid::parse_str(row.get("message_id")).map_err(db)?),
                    EventId(Uuid::parse_str(row.get("event_id")).map_err(db)?),
                    row.get::<String, _>("request_key"),
                ))
            })
            .collect()
    }
}
