//! Durable owner-authored Worker subtasks. Task data does not grant provider I/O.
use super::*;
use crate::runtime::ledger::{hash, secret};
use orkestr_v2_contracts::{
    ConversationId, EventId, MessageId, RunId, TaskId, WorkerTaskCreateRequest, WorkerTaskList,
    WorkerTaskPhase, WorkerTaskReceipt, WorkerTaskStatus, MAX_WORKER_TASKS_PER_PARENT,
};
use sqlx::sqlite::SqliteRow;

mod claim;
mod creation;
mod input;
mod presentation;

/// Private one-use queue claim. It is not a provider execution grant and cannot
/// be reconstructed from a receipt, browser task ID, or provider output.
pub struct WorkerTaskClaim {
    id: TaskId,
    locator: String,
    parent: RunAdmission,
    source_message: MessageId,
    source_event: EventId,
    lifetime_ms: u32,
}
impl WorkerTaskClaim {
    pub fn task_id(&self) -> &TaskId {
        &self.id
    }
    /// Read-only captured identity; current parent authority is checked again
    /// during metadata setup and task delegation, never inferred from this copy.
    pub fn parent(&self) -> &RunAdmission {
        &self.parent
    }
    pub fn source_message_id(&self) -> &MessageId {
        &self.source_message
    }
    pub fn source_event_id(&self) -> &EventId {
        &self.source_event
    }
    pub fn lifetime_ms(&self) -> u32 {
        self.lifetime_ms
    }
}

fn request_digest(request: &WorkerTaskCreateRequest) -> String {
    hash(
        "worker-task-input-v1",
        &[
            &request.parent_run_id.to_string(),
            &request.expected_control_revision.to_string(),
            &request.request_key,
            &request.title,
            &request.instructions,
            &request.lifetime_ms.to_string(),
        ],
    )
}
fn delegation_key(id: &TaskId, digest: &str) -> String {
    format!("task:{id}:{digest}")
}
fn receipt(row: &SqliteRow) -> Result<WorkerTaskReceipt> {
    let result = WorkerTaskReceipt {
        schema_version: 1,
        task_id: TaskId(row.get::<String, _>("id").parse().map_err(db)?),
        conversation_id: ConversationId(
            row.get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        ),
        parent_run_id: RunId(row.get::<String, _>("parent_run_id").parse().map_err(db)?),
        source_message_id: MessageId(
            row.get::<String, _>("source_message_id")
                .parse()
                .map_err(db)?,
        ),
        source_event_id: EventId(
            row.get::<String, _>("source_event_id")
                .parse()
                .map_err(db)?,
        ),
        created_at_ms: row.get("created_at_ms"),
    };
    if !result.is_valid() {
        return Err(RuntimeStoreError::Unavailable);
    }
    Ok(result)
}

impl Store {
    async fn task_browser_in(
        &self,
        conn: &mut SqliteConnection,
        credential: &str,
        conversation: &ConversationId,
    ) -> Result<()> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let context = self.context()?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(context.owner.to_string())
            .fetch_one(&mut *conn).await.map_err(db)?;
        if count != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        crate::runtime::scope(conn, &context.owner, conversation).await
    }

    async fn task_parent_in(
        &self,
        conn: &mut SqliteConnection,
        row: &SqliteRow,
    ) -> Result<SqliteRow> {
        let context = self.context()?;
        if row.get::<&str, _>("owner_id") != context.owner.to_string()
            || row.get::<&str, _>("context_id") != context.id
            || row.get::<&str, _>("incarnation_id") != context.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let parent_id = RunId(row.get::<String, _>("parent_run_id").parse().map_err(db)?);
        let parent = self.worker_parent_current_in(conn, &parent_id).await?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
                .bind(parent_id.to_string())
                .fetch_one(&mut *conn)
                .await
                .map_err(db)?;
        if revision != row.get::<i64, _>("parent_control_revision")
            || parent.get::<&str, _>("conversation_id") != row.get::<&str, _>("conversation_id")
            || parent.get::<&str, _>("message_id") != row.get::<&str, _>("source_message_id")
            || parent.get::<&str, _>("event_id") != row.get::<&str, _>("source_event_id")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(parent)
    }
}

#[cfg(test)]
mod tests;
