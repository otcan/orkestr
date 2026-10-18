use super::*;
use crate::runtime::ledger::{hash, secret};
use sqlx::sqlite::SqliteRow;

pub(super) fn receipt(row: &SqliteRow) -> Result<WorkerDelegationReceipt> {
    Ok(WorkerDelegationReceipt {
        delegation_id: Uuid::parse_str(row.get("id")).map_err(db)?,
        owner_id: OwnerId(Uuid::parse_str(row.get("owner_id")).map_err(db)?),
        conversation_id: ConversationId(Uuid::parse_str(row.get("conversation_id")).map_err(db)?),
        parent_run_id: RunId(Uuid::parse_str(row.get("parent_run_id")).map_err(db)?),
        worker_session_id: SessionId(Uuid::parse_str(row.get("worker_session_id")).map_err(db)?),
        admitted_run_id: row
            .get::<Option<String>, _>("admitted_run_id")
            .map(|value| value.parse().map(RunId).map_err(db))
            .transpose()?,
        source_message_id: MessageId(Uuid::parse_str(row.get("source_message_id")).map_err(db)?),
        source_event_id: EventId(Uuid::parse_str(row.get("source_event_id")).map_err(db)?),
        lease_deadline_ms: row.get("expires_at_ms"),
        state: match row.get::<&str, _>("state") {
            "delegated" => WorkerDelegationState::Delegated,
            "admitted" => WorkerDelegationState::Admitted,
            "blocked" => WorkerDelegationState::Blocked,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
    })
}
impl Store {
    /// A trusted scheduler selects only the parent's immutable accepted input.
    /// Identical replay returns evidence, never a replacement admission locator.
    pub async fn delegate_worker(
        &self,
        credential: &str,
        parent_run_id: &RunId,
        input: &WorkerAdmissionInput,
    ) -> Result<WorkerDelegationResult> {
        self.worker_credential(credential)?;
        if !valid(&input.request_key)
            || !(1..=30_000).contains(&input.lifetime_ms)
            || input.expected_binding_generation == 0
            || i64::try_from(input.expected_binding_generation).is_err()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        let digest = hash(
            "worker-provider-input-v1",
            &[
                &parent_run_id.to_string(),
                &input.worker_binding_id.to_string(),
                &input.expected_binding_generation.to_string(),
                &input.source_message_id.to_string(),
                &input.source_event_id.to_string(),
                &input.request_key,
                &input.lifetime_ms.to_string(),
            ],
        );
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        if let Some(row) = sqlx::query("SELECT * FROM worker_provider_delegations WHERE owner_id=? AND parent_run_id=? AND request_key=?")
            .bind(c.owner.to_string()).bind(parent_run_id.to_string()).bind(&input.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<&str,_>("context_id") != c.id { return Err(RuntimeStoreError::Unauthorized); }
            if row.get::<&str,_>("input_digest") != digest { return Err(RuntimeStoreError::Conflict); }
            let result = receipt(&row)?;
            tx.commit().await.map_err(db)?;
            return Ok(WorkerDelegationResult::Existing(result));
        }
        let parent = self
            .worker_parent_in(&mut tx, credential, parent_run_id)
            .await?;
        if parent.get::<String, _>("message_id") != input.source_message_id.to_string()
            || parent.get::<String, _>("event_id") != input.source_event_id.to_string()
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let binding = sqlx::query("SELECT b.* FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.provider_kind=? AND b.provider_namespace=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(input.worker_binding_id.to_string()).bind(c.owner.to_string()).bind(parent.get::<&str,_>("conversation_id"))
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Unavailable)?;
        if binding.get::<&str, _>("role") != "worker"
            || binding
                .get::<Option<String>, _>("parent_session_id")
                .as_deref()
                != Some(parent.get::<&str, _>("session_id"))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if binding.get::<i64, _>("generation")
            != i64::try_from(input.expected_binding_generation).map_err(db)?
        {
            return Err(RuntimeStoreError::StaleLease);
        }
        if binding.get::<&str, _>("state") != "ready" {
            return Err(RuntimeStoreError::Busy);
        }
        let native: Option<String> = binding.get("native_session_id");
        if native.as_deref().is_none_or(str::is_empty) {
            return Err(RuntimeStoreError::Unavailable);
        }
        let clock = now(&mut tx).await?;
        let supervisor_deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let deadline = (clock + i64::from(input.lifetime_ms))
            .min(parent.get("lease_deadline_ms"))
            .min(supervisor_deadline);
        if deadline <= clock {
            return Err(RuntimeStoreError::Expired);
        }
        let id = Uuid::new_v4();
        let locator = secret();
        sqlx::query("INSERT INTO worker_provider_delegations(id,owner_id,conversation_id,parent_run_id,parent_session_id,context_id,incarnation_id,parent_binding_generation,parent_lease_generation,parent_dispatch_fence,parent_deadline_ms,worker_session_id,worker_binding_generation,source_message_id,source_event_id,request_key,input_digest,requested_lifetime_ms,expires_at_ms,state,grant_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'delegated',?)")
            .bind(id.to_string()).bind(c.owner.to_string()).bind(parent.get::<&str,_>("conversation_id"))
            .bind(parent_run_id.to_string()).bind(parent.get::<&str,_>("session_id"))
            .bind(&c.id).bind(&c.incarnation).bind(parent.get::<i64,_>("binding_generation"))
            .bind(parent.get::<i64,_>("lease_generation")).bind(parent.get::<i64,_>("dispatch_fence"))
            .bind(parent.get::<i64,_>("lease_deadline_ms")).bind(input.worker_binding_id.to_string())
            .bind(i64::try_from(input.expected_binding_generation).map_err(db)?)
            .bind(input.source_message_id.to_string()).bind(input.source_event_id.to_string())
            .bind(&input.request_key).bind(digest).bind(i64::from(input.lifetime_ms)).bind(deadline)
            .bind(hash("worker-provider-grant-v1", &[&locator])).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(WorkerDelegationResult::Fresh(WorkerDelegation {
            _id: id,
            _locator: locator,
        }))
    }
}
