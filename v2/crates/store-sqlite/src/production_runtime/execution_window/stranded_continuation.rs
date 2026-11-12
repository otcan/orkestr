//! ORK-783: an automatic result (a source continuation, for example a host
//! tool result) released by a window that ended before its turn came.
//!
//! Like a timer occurrence it has no sender who could send it again: the
//! adapter re-admits released owner messages, but nothing re-admits a result.
//! Its queue intent stayed `dispatched` to the closed window and Core claims
//! only inputs of the current window, so it never ran and was never retired
//! (about 860 host results on 2026-11-12). Its queue intent now goes back in
//! line exactly once, under its own retry key, the same way
//! `open::retry_timer_inputs` handles a timer. The dispatcher then rechecks
//! its source fence before any window opens for it: a result whose source
//! turn is still the session's latest gets its one continuation turn
//! (`continuation_groups`); one whose session moved on is retired with a
//! receipt (`superseded_source`). A second release leaves it released.
use super::*;

pub(super) async fn retry_continuation_inputs(
    tx: &mut SqliteConnection,
    window: Uuid,
    release: &[String],
    failed_open: bool,
) -> Result<()> {
    const FIRST_RETRY: u32 = 1;
    // Closed constant SQL, never caller data: this one release is the only
    // archived release of the event.
    let released_once = if failed_open {
        "(SELECT count(*) FROM execution_window_open_failure_inputs f WHERE f.event_id=?1)=1 AND NOT EXISTS(SELECT 1 FROM execution_window_released_inputs f WHERE f.event_id=?1)"
    } else {
        "(SELECT count(*) FROM execution_window_released_inputs f WHERE f.event_id=?1)=1 AND NOT EXISTS(SELECT 1 FROM execution_window_open_failure_inputs f WHERE f.event_id=?1)"
    };
    let key = super::queue::SOURCE_CONTINUATION_KEY;
    for event in release {
        let Some(row) = sqlx::query(&format!("SELECT q.message_id,q.input_request_key FROM execution_window_queue q JOIN reasoning_inbox i ON i.event_id=q.event_id AND i.message_id=q.message_id WHERE q.event_id=?1 AND q.window_id=?2 AND q.state='dispatched' AND q.request_key=?3||?1 AND i.state='queued' AND EXISTS(SELECT 1 FROM source_admission_fences f WHERE f.message_id=q.message_id) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=?1) AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=?1) AND {released_once}"))
            .bind(event)
            .bind(window.to_string())
            .bind(key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        else {
            continue;
        };
        let retry = super::queue::continuation_retry_intent(
            MessageId(row.get::<String, _>("message_id").parse().map_err(db)?),
            EventId(event.parse().map_err(db)?),
            row.get::<&str, _>("input_request_key"),
            FIRST_RETRY,
        );
        if !retry.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let digest = crate::digest(&serde_json::to_string(&retry).map_err(db)?);
        let moved = sqlx::query("UPDATE execution_window_queue SET state='queued',window_id=NULL,request_key=?4,semantic_digest=?5 WHERE event_id=?1 AND window_id=?2 AND state='dispatched' AND request_key=?3||?1")
            .bind(event)
            .bind(window.to_string())
            .bind(key)
            .bind(&retry.request_key)
            .bind(digest)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        if moved != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    Ok(())
}
