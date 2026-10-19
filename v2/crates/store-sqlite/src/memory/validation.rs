use super::*;

pub(super) fn key(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn text(s: &mut String, max: usize) -> Result<()> {
    if s.len() > max
        || s.trim().is_empty()
        || s.chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(MemoryError::Invalid);
    }
    *s = s.trim().to_owned();
    Ok(())
}
fn time(t: i64) -> bool {
    (0..=253402300799999).contains(&t)
}
pub(super) fn normalize(operation: &mut MemoryOperation) -> Result<()> {
    let c = match operation {
        MemoryOperation::Create { candidate } => candidate,
        MemoryOperation::Correct {
            memory_id,
            expected_revision,
            candidate,
        } => {
            target(*memory_id, *expected_revision)?;
            candidate
        }
        MemoryOperation::Forget {
            memory_id,
            expected_revision,
        } => return target(*memory_id, *expected_revision),
    };
    let task = match &mut c.content {
        MemoryContent::Preference { key, value } => {
            text(key, 128)?;
            text(value, 4096)?;
            None
        }
        MemoryContent::Fact { statement } => {
            text(statement, 4096)?;
            None
        }
        MemoryContent::Decision { summary, rationale } => {
            text(summary, 4096)?;
            if let Some(r) = rationale {
                text(r, 2048)?;
            }
            None
        }
        MemoryContent::Commitment {
            summary,
            task_id,
            due_at_ms,
        }
        | MemoryContent::OpenLoop {
            summary,
            task_id,
            due_at_ms,
        } => {
            text(summary, 4096)?;
            if due_at_ms.is_some_and(|v| !time(v)) {
                return Err(MemoryError::Invalid);
            }
            task_id.as_ref()
        }
        MemoryContent::ProjectSummary { summary } => {
            text(summary, 8192)?;
            if !matches!(c.scope, MemoryScope::Project { .. }) {
                return Err(MemoryError::Invalid);
            }
            None
        }
    };
    if task.is_some() && c.source.task_id.is_some() && task != c.source.task_id.as_ref() {
        return Err(MemoryError::Invalid);
    }
    if (task.is_some() || c.source.task_id.is_some()) && matches!(c.scope, MemoryScope::Owner) {
        return Err(MemoryError::Invalid);
    }
    if !identifier(&c.source.actor_id, 160)
        || !identifier(&c.source.origin, 64)
        || !time(c.source.captured_at_ms)
        || c.source.cursor.as_ref().is_some_and(|v| !key(v, 256))
        || c.source.task_id.as_ref().is_some_and(|v| v.0.is_nil())
        || c.source.event_id.as_ref().is_some_and(|v| v.0.is_nil())
    {
        return Err(MemoryError::Invalid);
    }
    if serde_json::to_vec(c).map_err(db)?.len() > 32768 {
        return Err(MemoryError::Invalid);
    }
    Ok(())
}
fn target(id: Uuid, revision: u64) -> Result<()> {
    if id.is_nil() || revision == 0 || revision >= i64::MAX as u64 {
        Err(MemoryError::Invalid)
    } else {
        Ok(())
    }
}
pub(super) fn proposal_digest(key: &str, operation: &MemoryOperation) -> Result<String> {
    Ok(crate::digest(
        &serde_json::to_string(&("orkestr-memory-proposal-v1", key, operation)).map_err(db)?,
    ))
}
pub(super) async fn project(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    id: &ProjectId,
) -> Result<()> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM projects WHERE id=? AND owner_id=?")
        .bind(id.to_string())
        .bind(owner.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(db)?;
    if id.0.is_nil() || n != 1 {
        return Err(MemoryError::NotFound);
    }
    Ok(())
}
pub(super) async fn validate_operation(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    operation: &MemoryOperation,
) -> Result<()> {
    let candidate = match operation {
        MemoryOperation::Create { candidate } => Some(candidate),
        MemoryOperation::Correct {
            memory_id,
            candidate,
            ..
        } => {
            let old = super::read::record(tx, owner, *memory_id).await?;
            if old.candidate.scope != candidate.scope {
                return Err(MemoryError::Conflict);
            }
            Some(candidate)
        }
        MemoryOperation::Forget { memory_id, .. } => {
            super::read::record(tx, owner, *memory_id).await?;
            None
        }
    };
    if let Some(c) = candidate {
        if c.source.kind == MemorySourceKind::Owner && c.source.actor_id != owner.to_string() {
            return Err(MemoryError::Unauthorized);
        }
        if let MemoryScope::Project { project_id } = &c.scope {
            project(tx, owner, project_id).await?;
        }
        let task = match &c.content {
            MemoryContent::Commitment { task_id, .. } | MemoryContent::OpenLoop { task_id, .. } => {
                task_id.as_ref()
            }
            _ => None,
        }
        .or(c.source.task_id.as_ref());
        if let Some(task) = task {
            let MemoryScope::Project { project_id } = &c.scope else {
                return Err(MemoryError::Invalid);
            };
            let n:i64=sqlx::query_scalar("SELECT count(*) FROM worker_tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND t.owner_id=? AND c.owner_id=? AND c.project_id=?")
                .bind(task.to_string()).bind(owner.to_string()).bind(owner.to_string()).bind(project_id.to_string())
                .fetch_one(&mut **tx).await.map_err(db)?;
            if n != 1 {
                return Err(MemoryError::NotFound);
            }
        }
        if let Some(event) = &c.source.event_id {
            let scope = match &c.scope {
                MemoryScope::Owner => None,
                MemoryScope::Project { project_id } => Some(project_id.to_string()),
            };
            let n:i64=sqlx::query_scalar("SELECT count(*) FROM events e JOIN conversations c ON c.id=e.conversation_id WHERE e.id=? AND e.owner_id=? AND c.project_id IS ?")
                .bind(event.to_string()).bind(owner.to_string()).bind(scope).fetch_one(&mut **tx).await.map_err(db)?;
            if n != 1 {
                return Err(MemoryError::NotFound);
            }
        }
    }
    Ok(())
}
pub(super) fn consent(
    proposal: &MemoryProposal,
    decision: &MemoryOwnerDecision,
) -> Result<MemoryTrust> {
    if decision.digest != proposal.digest {
        return Err(MemoryError::Unauthorized);
    }
    let (candidate, expected) = match &proposal.operation {
        MemoryOperation::Create { candidate } => (Some(candidate), None),
        MemoryOperation::Correct { candidate, .. } => {
            (Some(candidate), Some(MemoryConsentAction::Correct))
        }
        MemoryOperation::Forget { .. } => (None, Some(MemoryConsentAction::Forget)),
    };
    if let Some(expected) = expected {
        if decision.action != expected {
            return Err(MemoryError::Unauthorized);
        }
    } else if !matches!(
        decision.action,
        MemoryConsentAction::Remember | MemoryConsentAction::Approve
    ) {
        return Err(MemoryError::Unauthorized);
    }
    if let Some(c) = candidate {
        if decision.action == MemoryConsentAction::Remember
            && c.source.kind != MemorySourceKind::Owner
        {
            return Err(MemoryError::Unauthorized);
        }
        if c.source.kind == MemorySourceKind::Owner
            && decision.action != MemoryConsentAction::Approve
        {
            return Ok(MemoryTrust::OwnerAuthored);
        }
    }
    Ok(MemoryTrust::OwnerConfirmed)
}

fn identifier(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
