//! Proposed durable owner authority. Core registers schema and trusted issuer seam.
//! Imported schedules have no row here and therefore no execution authority.
use super::input::{TimerInputReceipt, TimerInputRequest};
use super::*;

#[derive(Clone, Debug)]
pub struct DurableTimerEnable {
    pub timer: TimerEnableRequest,
    /// Fresh target-owner instructions; never copied from legacy schedules.
    pub instruction: String,
}
#[derive(Clone, Debug)]
pub struct DurableTimerAuthority {
    pub authority_id: Uuid,
    pub namespace: Uuid,
    pub generation: i64,
    pub conversation_id: ConversationId,
    pub instruction_digest: String,
    pub duplicate: bool,
}
pub(super) fn instruction_digest(instruction: &str) -> String {
    hash(&serde_json::json!(["orkestr.timer.owner-instruction.v1", instruction]).to_string())
}
fn authority(row: &SqliteRow, duplicate: bool) -> Result<DurableTimerAuthority> {
    Ok(DurableTimerAuthority {
        authority_id: Uuid::parse_str(row.get("authority_id")).map_err(unavailable)?,
        namespace: Uuid::parse_str(row.get("namespace")).map_err(unavailable)?,
        generation: row.get("generation"),
        conversation_id: ConversationId(
            Uuid::parse_str(row.get("conversation_id")).map_err(unavailable)?,
        ),
        instruction_digest: row.get("instruction_digest"),
        duplicate,
    })
}
/// The durable enable inside an already authorized write transaction: the
/// immutable instruction and the enable commit together.
pub(super) async fn enable_durable_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    request: &DurableTimerEnable,
    now_ms: i64,
) -> Result<DurableTimerAuthority> {
    if request.instruction.trim().is_empty() || request.instruction.len() > 32768 {
        return Err(HistoryError::Invalid);
    }
    let digest = instruction_digest(&request.instruction);
    // Lookup is after auth, before attempting any new transition.
    let old=sqlx::query("SELECT * FROM durable_timer_authorities WHERE owner_id=? AND namespace=? AND request_key=?")
        .bind(owner.to_string()).bind(request.timer.namespace.to_string()).bind(&request.timer.request_key).fetch_optional(&mut **tx).await.map_err(unavailable)?;
    if let Some(old) = old {
        if old.get::<String, _>("instruction") != request.instruction
            || old.get::<String, _>("instruction_digest") != digest
            || old.get::<String, _>("conversation_id") != request.timer.conversation_id.to_string()
            || old.get::<i64, _>("expected_revision") != request.timer.expected_revision
        {
            return Err(HistoryError::Conflict);
        }
        // Historical retry is read-only: never renew, re-enable or recreate authority.
        return authority(&old, true);
    }
    let enabled = input::enable_in_transaction(tx, owner, &request.timer, now_ms).await?;
    if enabled.duplicate {
        return Err(HistoryError::Conflict);
    }
    let stop: i64=sqlx::query_scalar("SELECT stop_sequence FROM dormant_timer_input_guards WHERE owner_id=? AND namespace=? AND generation=?")
        .bind(owner.to_string()).bind(request.timer.namespace.to_string()).bind(enabled.receipt.generation).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO durable_timer_authorities(owner_id,namespace,generation,authority_id,conversation_id,request_key,expected_revision,instruction,instruction_digest,stop_sequence) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(request.timer.namespace.to_string()).bind(enabled.receipt.generation).bind(id.to_string()).bind(request.timer.conversation_id.to_string()).bind(&request.timer.request_key).bind(request.timer.expected_revision).bind(&request.instruction).bind(&digest).bind(stop).execute(&mut **tx).await.map_err(unavailable)?;
    Ok(DurableTimerAuthority {
        authority_id: id,
        namespace: request.timer.namespace,
        generation: enabled.receipt.generation,
        conversation_id: request.timer.conversation_id.clone(),
        instruction_digest: digest,
        duplicate: false,
    })
}
impl Store {
    /// Current owner auth before replay; immutable instructions and enable commit together.
    pub async fn enable_durable_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &DurableTimerEnable,
    ) -> Result<DurableTimerAuthority> {
        if request.instruction.trim().is_empty() || request.instruction.len() > 32768 {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now_ms = store_clock(&mut tx).await?;
        let result = enable_durable_in(&mut tx, owner, request, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    /// Revoke uses the canonical disable transaction: cancels claims, changes generation,
    /// and immediately holds outstanding ordinary inputs through Core eligibility filters.
    pub async fn revoke_durable_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        expected_revision: i64,
        request_key: String,
    ) -> Result<TimerReceipt> {
        self.control_dormant_timer(
            credential,
            owner,
            &TimerControlRequest {
                namespace,
                expected_revision,
                request_key,
                action: TimerControl::Disable,
            },
        )
        .await
    }
    /// Trusted local supervisor only. Core owns issuer construction and per-call validation.
    /// Clock is server-owned; HTTP must never expose this API or take a client due/claim.
    pub async fn admit_authorized_timer(
        &self,
        issuer: &crate::TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> Result<TimerInputReceipt> {
        let (mut tx, owner) = self.timer_scheduler_transaction(issuer, namespace).await?;
        let now_ms = store_clock(&mut tx).await?;
        let result = admit_in_transaction(&mut tx, &owner, namespace, now_ms).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}

pub(crate) async fn store_clock(tx: &mut Transaction<'_, Sqlite>) -> Result<i64> {
    sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)
}
// The only production caller supplies the transaction's Store clock. Tests may
// inject synthetic future observations here without granting an HTTP clock port.
pub(crate) async fn admit_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    now_ms: i64,
) -> Result<TimerInputReceipt> {
    let current = row(tx, owner, namespace).await?;
    let timer = receipt(&current)?;
    if timer.state != TimerState::Enabled {
        return Err(HistoryError::Conflict);
    }
    let grant = sqlx::query(
        "SELECT * FROM durable_timer_authorities WHERE owner_id=? AND namespace=? AND generation=?",
    )
    .bind(owner.to_string())
    .bind(namespace.to_string())
    .bind(timer.generation)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(HistoryError::Unauthorized)?;
    let instruction: String = grant.get("instruction");
    if instruction_digest(&instruction) != grant.get::<String, _>("instruction_digest")
        || grant.get::<String, _>("conversation_id") != current.get::<String, _>("conversation_id")
    {
        return Err(HistoryError::Conflict);
    }
    let due = timer.next_due_ms.ok_or(HistoryError::Conflict)?;
    // A pause or skip date set after the scheduler chose this occurrence wins.
    let conversation: String = current.get("conversation_id");
    let schedule = schedule::decode(current.get("schedule_json"))?;
    if policy_pause::load(tx, owner, namespace, &schedule, Some(&conversation))
        .await?
        .blocks(due)
    {
        return Err(HistoryError::Conflict);
    }
    let request = TimerInputRequest {
        claim: TimerClaimRequest {
            namespace,
            generation: timer.generation,
            due_ms: due,
            request_key: format!("durable:{}:{}", timer.generation, due),
        },
        text: instruction,
    };
    // Existing sole writer rechecks current Stop watermark, claims/cadence, target
    // ownership and ordinary dedupe in this same issuer-authenticated transaction.
    let result = input::admit_in_transaction(tx, owner, &request, now_ms).await?;

    Ok(result)
}

#[cfg(test)]
mod tests;
