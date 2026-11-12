//! Automatic results handed back to a finished Deep turn (ORK-733, ORK-783).
//!
//! A host tool result (or another automatic result) reaches the turn that
//! requested it twice: the broker publishes it where that turn can read it
//! while it still runs, then posts it to Core as an input fenced to that turn
//! (`source_admission_fences`). Core cannot see whether the turn read it. So
//! once the turn was accepted, its first queued result became a turn of its
//! own (the fence still held), the agent answered "no change" as a "Task
//! update", and every later result of the same turn was retired unseen as
//! superseded (ORK-795).
//!
//! Now the first queued result of an accepted source turn takes every other
//! queued result of that same turn into its one continuation turn, consumed
//! in the same admission commit. The turn text lists them and tells the agent
//! to answer exactly NO_REPLY when its previous answer already used them all:
//! the session that read them is the only record of that, and a NO_REPLY
//! answer is never sent to the chat. A result the previous turn did not use
//! is answered in that one turn. So a source turn gets at most one
//! continuation, and none of its queued results is retired unseen.
//!
//! Only continuations of an accepted (succeeded) source turn are grouped.
//! Release and deadline continuations continue a cancelled run (ORK-792):
//! they are not results, and keep their own single turn and exact text.
use super::*;
use orkestr_v2_contracts::ConversationId;
use sqlx::sqlite::SqliteRow;

/// At most this many results (the head included) in one continuation turn:
/// one window takes at most 32 managed operations.
pub(crate) const CONTINUATION_GROUP_MAX_INPUTS: usize = 32;

/// The accepted source turn `message` continues, with the provider generation
/// its fence froze; None for an input without a fence, or one that continues
/// a cancelled run (a release or deadline continuation).
async fn accepted_source(
    conn: &mut SqliteConnection,
    conversation: &str,
    message: &str,
) -> Result<Option<(String, i64)>> {
    let row = sqlx::query("SELECT f.source_run_id,f.expected_provider_generation FROM source_admission_fences f JOIN messages m ON m.id=f.message_id JOIN production_runs r ON r.id=f.source_run_id AND r.owner_id=m.owner_id AND r.conversation_id=m.conversation_id WHERE f.message_id=? AND m.conversation_id=? AND r.role='deep' AND r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)")
        .bind(message).bind(conversation)
        .fetch_optional(&mut *conn).await.map_err(db)?;
    Ok(row.map(|row| {
        (
            row.get("source_run_id"),
            row.get("expected_provider_generation"),
        )
    }))
}

/// Consume, for the Deep run `run` that just consumed the claimed head input
/// at `head`, every other queued result of the head's accepted source turn.
/// Called only inside that admission transaction, after the head's own
/// source fence was validated in it: each member carries the same fence (the
/// same source run, so the same native session, provider and binding
/// generation, and the same frozen provider generation), so it holds too.
/// Members must have joined the current window and must not be held, like any
/// claimable input. Returns the number consumed in addition to the head.
pub(super) async fn form(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
    head: i64,
    head_message: &str,
    window: Option<&str>,
    run: &str,
) -> Result<usize> {
    let conversation = conversation.to_string();
    let session: String = sqlx::query_scalar("SELECT session_id FROM production_runs WHERE id=?")
        .bind(run)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if super::parallel_deep::is_slot(tx, &session).await? {
        return Ok(0);
    }
    let Some((source, generation)) = accepted_source(tx, &conversation, head_message).await? else {
        return Ok(0);
    };
    let head_bytes: i64 =
        sqlx::query_scalar("SELECT length(CAST(text AS BLOB)) FROM messages WHERE id=?")
            .bind(head_message)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    let rows = sqlx::query("SELECT i.sequence,length(CAST(m.text AS BLOB)) AS bytes FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id AND m.conversation_id=i.conversation_id JOIN source_admission_fences f ON f.message_id=i.message_id WHERE i.conversation_id=?1 AND i.sequence>?2 AND i.state='queued' AND f.source_run_id=?3 AND f.expected_provider_generation=?4 AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) AND (?5 IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=?5 AND wi.event_id=i.event_id)) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=i.event_id OR r.message_id=i.message_id) ORDER BY i.sequence LIMIT ?6")
        .bind(&conversation).bind(head).bind(&source).bind(generation).bind(window)
        .bind(CONTINUATION_GROUP_MAX_INPUTS as i64 - 1)
        .fetch_all(&mut *tx).await.map_err(db)?;
    let mut bytes = usize::try_from(head_bytes).map_err(db)?;
    let mut consumed = 0;
    for row in rows {
        let size = usize::try_from(row.get::<i64, _>("bytes")).map_err(db)?;
        if bytes + size > super::deep_groups::DEEP_GROUP_TEXT_BUDGET {
            break; // The rest stays queued, in order.
        }
        bytes += size;
        let changed = sqlx::query("UPDATE reasoning_inbox SET state='consumed',admitted_run_id=? WHERE conversation_id=? AND sequence=? AND state='queued'")
            .bind(run).bind(&conversation).bind(row.get::<i64, _>("sequence"))
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        consumed += 1;
    }
    Ok(consumed)
}

/// The Deep turn text of a run whose head continues an accepted source turn
/// (one result or several), or None for any other run.
pub(super) async fn text(conn: &mut SqliteConnection, run: &SqliteRow) -> Result<Option<String>> {
    if run.get::<&str, _>("role") != "deep" {
        return Ok(None);
    }
    let conversation: String = run.get("conversation_id");
    let head: String = run.get("message_id");
    let Some((source, _)) = accepted_source(conn, &conversation, &head).await? else {
        return Ok(None);
    };
    let rows = sqlx::query("SELECT i.sequence,i.message_id,m.text FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id AND m.conversation_id=i.conversation_id JOIN source_admission_fences f ON f.message_id=i.message_id WHERE i.conversation_id=? AND i.sequence>=? AND i.admitted_run_id=? AND i.state='consumed' AND f.source_run_id=? ORDER BY i.sequence LIMIT ?")
        .bind(&conversation).bind(run.get::<i64, _>("scope_sequence")).bind(run.get::<String, _>("id"))
        .bind(&source).bind(CONTINUATION_GROUP_MAX_INPUTS as i64)
        .fetch_all(&mut *conn).await.map_err(db)?;
    if rows.first().map(|row| row.get::<String, _>("message_id")) != Some(head) {
        return Err(RuntimeStoreError::Conflict);
    }
    let items: Vec<(i64, String, String)> = rows
        .iter()
        .map(|row| (row.get("sequence"), row.get("message_id"), row.get("text")))
        .collect();
    // Members join only within the text budget; a single head that alone
    // exceeds it keeps its plain text, as before, so no turn grows past the
    // provider's input bound.
    if items.len() == 1 && items[0].2.len() > super::deep_groups::DEEP_GROUP_TEXT_BUDGET {
        return Ok(None);
    }
    Ok(Some(render(&items)))
}

/// Header of a continuation turn; `%N%` is the number of results.
const RESULTS_NOTE: &str = "[Automatic results: %N% result(s) of requests your previous turn made (for example host tool operations), listed below with their source references. That turn could read each result while it was still running and may already have used it. Continue the task with anything it has not used yet. If every result below is already reflected in your previous answer and the owner needs no new message, answer exactly NO_REPLY and nothing else.]";

/// The header, then each result numbered in arrival order.
pub(super) fn render(items: &[(i64, String, String)]) -> String {
    let mut out = RESULTS_NOTE.replace("%N%", &items.len().to_string());
    for (index, (sequence, message, text)) in items.iter().enumerate() {
        out.push_str(&format!(
            "\n\n{}. [source: message {message}, sequence {sequence}]\n{}",
            index + 1,
            text.trim_end()
        ));
    }
    out
}

#[cfg(test)]
mod render_tests {
    #[test]
    fn every_result_is_numbered_under_one_note_that_allows_no_reply() {
        let text = super::render(&[
            (7, "m-7".into(), "First result\n".into()),
            (9, "m-9".into(), "Second result".into()),
        ]);
        assert!(text.starts_with("[Automatic results: 2 result(s) "));
        assert!(text.contains("answer exactly NO_REPLY and nothing else.]"));
        assert!(text.ends_with(
            "\n\n1. [source: message m-7, sequence 7]\nFirst result\n\n2. [source: message m-9, sequence 9]\nSecond result"
        ));
    }
}
