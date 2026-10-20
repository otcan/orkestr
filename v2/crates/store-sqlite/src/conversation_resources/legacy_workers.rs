//! V1 worker sub-thread links under the parent's V2 conversation. A worktree
//! has one writer at a time; V1 -> V2 always passes through `none`, and V2
//! can claim only after the V1 worker is retired in a fresh V1 snapshot.
use super::{now_ms, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};

fn parse<T>(value: Option<T>) -> Result<T> {
    value.ok_or(ResourceError::Unavailable)
}
fn link_of(row: &SqliteRow) -> Result<LegacyWorkerLink> {
    let conversation = uuid::Uuid::parse_str(row.get::<String, _>("conversation_id").as_str())
        .map_err(unavailable)?;
    let task = row
        .get::<Option<String>, _>("v2_task_id")
        .map(|t| uuid::Uuid::parse_str(&t).map(TaskId))
        .transpose()
        .map_err(unavailable)?;
    Ok(LegacyWorkerLink {
        conversation_id: ConversationId(conversation),
        source_instance: row.get("source_instance"),
        last_snapshot_id: row.get("last_snapshot_id"),
        record: LegacyWorkerRecord {
            source_thread_id: row.get("source_thread_id"),
            source_parent_thread_id: row.get("source_parent_thread_id"),
            worker_index: row.get::<Option<i64>, _>("worker_index").map(|i| i as u32),
            title: row.get("title"),
            source_state: parse(LegacyWorkerSourceState::parse(row.get("source_state")))?,
            branch: row.get("branch"),
            worktree_path: row.get("worktree_path"),
        },
        disposition: parse(LegacyWorkerDisposition::parse(row.get("disposition")))?,
        worktree_writer: parse(WorktreeWriter::parse(row.get("worktree_writer")))?,
        v2_task_id: task,
        archived_messages: row.get("archived_messages"),
        revision: row.get("revision"),
    })
}
const SELECT: &str = "SELECT l.*,coalesce(a.message_count,0) AS archived_messages FROM legacy_worker_links l
 LEFT JOIN archived_history_sources a ON a.owner_id=l.owner_id AND a.conversation_id=l.conversation_id
 AND a.source_instance=l.source_instance AND a.source_thread_id=l.source_thread_id";

async fn find(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    instance: &str,
    thread: &str,
) -> Result<Option<(i64, LegacyWorkerLink)>> {
    let row = sqlx::query(&format!(
        "{SELECT} WHERE l.owner_id=? AND l.source_instance=? AND l.source_thread_id=?"
    ))
    .bind(owner.to_string())
    .bind(instance)
    .bind(thread)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?;
    row.map(|r| Ok((r.get("row_sequence"), link_of(&r)?)))
        .transpose()
}

async fn save(
    tx: &mut Transaction<'_, Sqlite>,
    row: i64,
    link: &LegacyWorkerLink,
    action: &str,
) -> Result<()> {
    let changed = sqlx::query("UPDATE legacy_worker_links SET title=?,source_state=?,last_snapshot_id=?,disposition=?,worktree_writer=?,v2_task_id=?,revision=? WHERE row_sequence=? AND revision=?")
        .bind(&link.record.title).bind(link.record.source_state.as_str()).bind(&link.last_snapshot_id)
        .bind(link.disposition.as_str()).bind(link.worktree_writer.as_str())
        .bind(link.v2_task_id.as_ref().map(|t| t.to_string())).bind(link.revision)
        .bind(row).bind(link.revision - 1)
        .execute(&mut **tx).await;
    match changed {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => return Err(ResourceError::Conflict("worker_revision_mismatch")),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(ResourceError::Conflict("worktree_claimed"))
        }
        Err(e) => return Err(unavailable(e)),
    }
    audit(tx, row, link, action).await
}
async fn audit(
    tx: &mut Transaction<'_, Sqlite>,
    row: i64,
    link: &LegacyWorkerLink,
    action: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO legacy_worker_transitions(link_row,revision,action,disposition,worktree_writer,source_state,snapshot_id,recorded_at_ms) VALUES(?,?,?,?,?,?,?,?)")
        .bind(row).bind(link.revision).bind(action).bind(link.disposition.as_str())
        .bind(link.worktree_writer.as_str()).bind(link.record.source_state.as_str())
        .bind(&link.last_snapshot_id).bind(now_ms())
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}

/// Applies an action to a copy; `Ok(false)` means it is already in effect.
fn apply(link: &mut LegacyWorkerLink, action: &LegacyWorkerAction) -> Result<bool> {
    use LegacyWorkerDisposition as D;
    use WorktreeWriter as W;
    let retired = link.record.source_state == LegacyWorkerSourceState::Retired;
    let conflict = |code| Err(ResourceError::Conflict(code));
    match action {
        LegacyWorkerAction::SetDisposition { disposition } => {
            if *disposition == link.disposition {
                return Ok(false);
            }
            if link.v2_task_id.is_some() {
                return conflict("worker_task_linked");
            }
            match disposition {
                D::Archived if !retired => return conflict("worker_still_active"),
                D::FinishInV1 if retired => return conflict("worker_retired"),
                D::FinishInV1 if link.worktree_writer == W::V2 => {
                    return conflict("worktree_owned_by_v2")
                }
                _ => {}
            }
            link.disposition = *disposition;
        }
        LegacyWorkerAction::ReleaseV1Worktree => {
            if link.worktree_writer != W::V1 {
                return conflict("worktree_not_v1");
            }
            if !retired {
                return conflict("worker_still_active");
            }
            link.worktree_writer = W::None;
        }
        LegacyWorkerAction::ClaimV2Worktree => {
            if link.worktree_writer == W::V2 {
                return Ok(false);
            }
            if link.record.worktree_path.is_none() {
                return conflict("worktree_unavailable");
            }
            if link.worktree_writer != W::None {
                return conflict("worktree_not_released");
            }
            if !retired {
                return conflict("worker_still_active");
            }
            if link.disposition == D::FinishInV1 {
                return conflict("disposition_finish_in_v1");
            }
            link.worktree_writer = W::V2;
        }
        LegacyWorkerAction::ReleaseV2Worktree => {
            if link.worktree_writer != W::V2 {
                return conflict("worktree_not_v2");
            }
            link.worktree_writer = W::None;
        }
        LegacyWorkerAction::ReturnV1Worktree => {
            if link.worktree_writer == W::V1 {
                return Ok(false);
            }
            if link.worktree_writer != W::None {
                return conflict("worktree_not_released");
            }
            link.worktree_writer = W::V1;
        }
        LegacyWorkerAction::LinkTask { task_id } => {
            if link.v2_task_id.as_ref() == Some(task_id) {
                return Ok(false);
            }
            if link.v2_task_id.is_some() {
                return conflict("worker_task_linked");
            }
            if link.disposition != D::RecreateInV2 {
                return conflict("disposition_not_recreate");
            }
            link.v2_task_id = Some(task_id.clone());
        }
    }
    Ok(true)
}

impl Store {
    pub async fn legacy_workers(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<LegacyWorkerList> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let rows = sqlx::query(&format!(
            "{SELECT} WHERE l.owner_id=? AND l.conversation_id=? ORDER BY l.worker_index IS NULL,l.worker_index,l.row_sequence"
        ))
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let workers = rows.iter().map(link_of).collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(LegacyWorkerList {
            schema_version: 1,
            conversation_id: conversation.clone(),
            workers,
        })
    }

    /// Idempotent registration from a V1 snapshot. Identity changes and a V1
    /// restore of a worker whose worktree V2 owns are refused per worker.
    pub async fn register_legacy_workers(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &LegacyWorkerRegisterRequest,
    ) -> Result<LegacyWorkerRegisterReceipt> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let parents: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT source_parent_thread_id FROM legacy_worker_links WHERE owner_id=? AND conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        if parents
            .iter()
            .any(|p| *p != request.workers[0].source_parent_thread_id)
        {
            return Err(ResourceError::Conflict("parent_mismatch"));
        }
        let mut items = Vec::with_capacity(request.workers.len());
        for record in &request.workers {
            let outcome = register_one(&mut tx, owner, conversation, request, record).await?;
            items.push(LegacyWorkerRegisterItem {
                source_thread_id: record.source_thread_id.clone(),
                outcome,
            });
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(LegacyWorkerRegisterReceipt {
            conversation_id: conversation.clone(),
            items,
        })
    }

    pub async fn transition_legacy_worker(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        transition: &LegacyWorkerTransition,
    ) -> Result<LegacyWorkerLink> {
        if !transition.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let (row, mut link) = find(
            &mut tx,
            owner,
            &transition.source_instance,
            &transition.source_thread_id,
        )
        .await?
        .filter(|(_, l)| l.conversation_id == *conversation)
        .ok_or(ResourceError::NotFound)?;
        if let LegacyWorkerAction::LinkTask { task_id } = &transition.action {
            let found: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM worker_tasks WHERE id=? AND owner_id=? AND conversation_id=?",
            )
            .bind(task_id.to_string())
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
            if found != 1 {
                return Err(ResourceError::Conflict("worker_task_not_found"));
            }
        }
        if !apply(&mut link.clone(), &transition.action)? {
            tx.commit().await.map_err(unavailable)?;
            return Ok(link);
        }
        if link.revision != transition.expected_revision {
            return Err(ResourceError::Conflict("worker_revision_mismatch"));
        }
        apply(&mut link, &transition.action)?;
        link.revision += 1;
        let action = serde_json::to_value(&transition.action)
            .ok()
            .and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_owned))
            .ok_or(ResourceError::Unavailable)?;
        save(&mut tx, row, &link, &action).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(link)
    }
}

async fn register_one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    request: &LegacyWorkerRegisterRequest,
    record: &LegacyWorkerRecord,
) -> Result<LegacyWorkerRegisterOutcome> {
    use LegacyWorkerRegisterOutcome as O;
    use LegacyWorkerSourceState as S;
    let existing = find(
        tx,
        owner,
        &request.source_instance,
        &record.source_thread_id,
    )
    .await?;
    let Some((row, mut link)) = existing else {
        let retired = record.source_state == S::Retired;
        let link = LegacyWorkerLink {
            conversation_id: conversation.clone(),
            source_instance: request.source_instance.clone(),
            last_snapshot_id: request.snapshot_id.clone(),
            record: record.clone(),
            disposition: if retired {
                LegacyWorkerDisposition::Archived
            } else {
                LegacyWorkerDisposition::FinishInV1
            },
            worktree_writer: if record.worktree_path.is_some() {
                WorktreeWriter::V1
            } else {
                WorktreeWriter::None
            },
            v2_task_id: None,
            archived_messages: 0,
            revision: 1,
        };
        let row = sqlx::query("INSERT INTO legacy_worker_links(owner_id,conversation_id,source_instance,source_thread_id,source_parent_thread_id,worker_index,title,source_state,branch,worktree_path,last_snapshot_id,disposition,worktree_writer,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.source_instance)
            .bind(&record.source_thread_id).bind(&record.source_parent_thread_id)
            .bind(record.worker_index.map(i64::from)).bind(&record.title)
            .bind(record.source_state.as_str()).bind(&record.branch).bind(&record.worktree_path)
            .bind(&request.snapshot_id).bind(link.disposition.as_str()).bind(link.worktree_writer.as_str())
            .execute(&mut **tx).await.map_err(unavailable)?.last_insert_rowid();
        audit(tx, row, &link, "register").await?;
        return Ok(O::Inserted);
    };
    let old = &link.record;
    if link.conversation_id != *conversation
        || old.source_parent_thread_id != record.source_parent_thread_id
        || old.worker_index != record.worker_index
        || old.branch != record.branch
        || old.worktree_path != record.worktree_path
    {
        return Ok(O::Conflict);
    }
    if old.title == record.title && old.source_state == record.source_state {
        return Ok(O::Unchanged);
    }
    if old.source_state == S::Retired && record.source_state == S::Active {
        // V1 restored the worker: it writes again, so V2 must not own the tree.
        if link.worktree_writer == WorktreeWriter::V2 || link.v2_task_id.is_some() {
            return Ok(O::Conflict);
        }
        link.disposition = LegacyWorkerDisposition::FinishInV1;
        if link.record.worktree_path.is_some() {
            link.worktree_writer = WorktreeWriter::V1;
        }
    }
    if old.source_state == S::Active
        && record.source_state == S::Retired
        && link.disposition == LegacyWorkerDisposition::FinishInV1
    {
        // It finished in V1; what remains is its archived history.
        link.disposition = LegacyWorkerDisposition::Archived;
    }
    link.record.title = record.title.clone();
    link.record.source_state = record.source_state;
    link.last_snapshot_id = request.snapshot_id.clone();
    link.revision += 1;
    save(tx, row, &link, "register").await?;
    Ok(O::Updated)
}
